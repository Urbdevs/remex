// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RemexBridge
 * @author remex.mx
 * @notice Settlement contract for USDC remittances from USA to Mexico via Base L2.
 *
 * FLOW:
 *   1. Sender approves USDC → this contract
 *   2. Sender calls sendRemittance() with amount + CLABE hash + recipient info
 *   3. Contract emits RemittanceSent event (picked up by backend webhook listener)
 *   4. Backend confirms on-chain, calls Bitso Business API for USDC→MXN + SPEI payout
 *   5. When SPEI confirms, backend calls confirmDelivery() to close the loop on-chain
 *
 * SECURITY MODEL:
 *   - Ownable2Step: 2-step ownership transfer prevents accidental loss of control
 *   - ReentrancyGuard: protects USDC transfer operations
 *   - Pausable: emergency stop for all send operations
 *   - Role-based: only authorized relayers can confirm/refund
 *   - Min/max limits: per-transaction and daily limits enforced on-chain
 *   - Checks-Effects-Interactions: all state updates before external calls
 *
 * @dev USDC on Base Mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 * @dev USDC on Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 */
contract RemexBridge is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────
    // TYPES
    // ─────────────────────────────────────────────

    /// @notice Status of a remittance through its lifecycle
    enum RemittanceStatus {
        Pending,    // USDC received, waiting for backend processing
        Processing, // Bitso API called, SPEI in progress
        Delivered,  // SPEI confirmed by relayer — final state
        Refunded,   // Refund issued due to failure — final state
        Cancelled   // Cancelled before processing started
    }

    /// @notice On-chain record of each remittance
    struct Remittance {
        address sender;           // Who sent the USDC
        uint256 amount;           // USDC amount (6 decimals)
        uint256 feeAmount;        // Protocol fee deducted (6 decimals)
        bytes32 clabeHash;        // keccak256(clabe) — never store raw CLABE on-chain
        bytes32 recipientHash;    // keccak256(recipientName) — privacy by design
        uint64  createdAt;        // Block timestamp
        uint64  resolvedAt;       // When delivered or refunded (0 if pending)
        RemittanceStatus status;
    }

    // ─────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────

    /// @notice The USDC contract on Base
    IERC20 public immutable usdc;

    /// @notice Protocol fee in basis points (100 = 1%)
    uint256 public feeBasisPoints;

    /// @notice Minimum remittance in USDC (6 decimals). Default: 10 USDC
    uint256 public minAmount;

    /// @notice Maximum remittance in USDC (6 decimals). Default: 2999 USDC
    /// @dev FinCEN CTR threshold is $3,000 for enhanced reporting
    uint256 public maxAmount;

    /// @notice Treasury address that receives protocol fees
    address public treasury;

    /// @notice Counter for unique remittance IDs
    uint256 private _remittanceCounter;

    /// @notice All remittances by ID
    mapping(uint256 => Remittance) public remittances;

    /// @notice Authorized relayers (backend wallets that can confirm/refund)
    mapping(address => bool) public isRelayer;

    /// @notice Track sender's remittance IDs for easy lookup
    mapping(address => uint256[]) public senderRemittances;

    /// @notice Daily sent volume per sender (date => sender => amount)
    mapping(uint256 => mapping(address => uint256)) public dailyVolume;

    /// @notice Maximum daily send per address (6 decimals). Default: 5000 USDC
    uint256 public dailyLimit;

    /// @notice Total USDC volume processed (lifetime)
    uint256 public totalVolumeSent;

    /// @notice Total fees collected (lifetime)
    uint256 public totalFeesCollected;

    // ─────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────

    /**
     * @notice Emitted when a new remittance is initiated.
     * @dev Backend webhook listener indexes this event to trigger off-ramp.
     * @param remittanceId Unique identifier for this remittance
     * @param sender The wallet that sent USDC
     * @param amount Net USDC amount after fee (what gets converted to MXN)
     * @param feeAmount Protocol fee charged
     * @param clabeHash keccak256 of recipient's CLABE (for verification, not storage)
     * @param recipientHash keccak256 of recipient's name
     * @param timestamp Block timestamp
     */
    event RemittanceSent(
        uint256 indexed remittanceId,
        address indexed sender,
        uint256 amount,
        uint256 feeAmount,
        bytes32 indexed clabeHash,
        bytes32 recipientHash,
        uint64 timestamp
    );

    /**
     * @notice Emitted when backend confirms SPEI delivery.
     * @param remittanceId The remittance that was delivered
     * @param speiReference Banxico/SPEI reference number (off-chain proof)
     * @param mxnAmount Amount in MXN cents that was deposited (for transparency)
     * @param relayer Backend wallet that confirmed delivery
     */
    event RemittanceDelivered(
        uint256 indexed remittanceId,
        string  speiReference,
        uint256 mxnAmount,
        address relayer
    );

    /**
     * @notice Emitted when a remittance is refunded to sender.
     * @param remittanceId The remittance that was refunded
     * @param reason Human-readable refund reason (e.g., "SPEI_REJECTED")
     * @param relayer Backend wallet that issued the refund
     */
    event RemittanceRefunded(
        uint256 indexed remittanceId,
        string  reason,
        address relayer
    );

    /// @notice Emitted when a relayer is added or removed
    event RelayerUpdated(address indexed relayer, bool authorized);

    /// @notice Emitted when fee basis points change
    event FeeUpdated(uint256 oldFee, uint256 newFee);

    /// @notice Emitted when limits change
    event LimitsUpdated(uint256 minAmount, uint256 maxAmount, uint256 dailyLimit);

    /// @notice Emitted when treasury address changes
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    // ─────────────────────────────────────────────
    // ERRORS
    // ─────────────────────────────────────────────

    error AmountBelowMinimum(uint256 sent, uint256 minimum);
    error AmountAboveMaximum(uint256 sent, uint256 maximum);
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error InvalidClabeHash();
    error InvalidRecipientHash();
    error RemittanceNotFound(uint256 id);
    error InvalidStatusTransition(uint256 id, RemittanceStatus current, RemittanceStatus required);
    error NotRelayer(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint256 bps, uint256 max);
    error TreasuryWithdrawalFailed();

    // ─────────────────────────────────────────────
    // MODIFIERS
    // ─────────────────────────────────────────────

    modifier onlyRelayer() {
        if (!isRelayer[msg.sender]) revert NotRelayer(msg.sender);
        _;
    }

    modifier remittanceExists(uint256 id) {
        if (id == 0 || id > _remittanceCounter) revert RemittanceNotFound(id);
        _;
    }

    // ─────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────

    /**
     * @param _usdc Address of USDC token on Base
     * @param _treasury Address that receives protocol fees
     * @param _feeBasisPoints Initial fee in bps (140 = 1.4%)
     * @param _initialRelayer Backend wallet authorized to confirm deliveries
     */
    constructor(
        address _usdc,
        address _treasury,
        uint256 _feeBasisPoints,
        address _initialRelayer
    ) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_initialRelayer == address(0)) revert ZeroAddress();
        if (_feeBasisPoints > 500) revert FeeTooHigh(_feeBasisPoints, 500); // Max 5%

        usdc = IERC20(_usdc);
        treasury = _treasury;
        feeBasisPoints = _feeBasisPoints;

        // Default limits (USDC has 6 decimals)
        minAmount  = 10 * 1e6;    // $10 USDC
        maxAmount  = 2999 * 1e6;  // $2,999 USDC (below FinCEN CTR threshold)
        dailyLimit = 5000 * 1e6;  // $5,000 USDC/day

        isRelayer[_initialRelayer] = true;
        emit RelayerUpdated(_initialRelayer, true);
    }

    // ─────────────────────────────────────────────
    // CORE: SEND REMITTANCE
    // ─────────────────────────────────────────────

    /**
     * @notice Initiates a USDC remittance to be delivered via SPEI in Mexico.
     *
     * @dev The caller must have approved this contract for `amount` USDC beforehand.
     *      CLABE and recipient name are never stored raw — only their keccak256 hashes.
     *      This provides traceability without storing PII on-chain (GDPR/privacy by design).
     *
     * @param amount       Total USDC to send (including fee), in 6-decimal units
     * @param clabeHash    keccak256(abi.encodePacked(clabeString)) — computed off-chain
     * @param recipientHash keccak256(abi.encodePacked(recipientName)) — computed off-chain
     *
     * @return remittanceId Unique ID of this remittance for status tracking
     */
    function sendRemittance(
        uint256 amount,
        bytes32 clabeHash,
        bytes32 recipientHash
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 remittanceId)
    {
        // ── CHECKS ──────────────────────────────
        if (amount == 0) revert ZeroAmount();
        if (amount < minAmount) revert AmountBelowMinimum(amount, minAmount);
        if (amount > maxAmount) revert AmountAboveMaximum(amount, maxAmount);
        if (clabeHash == bytes32(0)) revert InvalidClabeHash();
        if (recipientHash == bytes32(0)) revert InvalidRecipientHash();

        // Daily volume check
        uint256 today = block.timestamp / 1 days;
        uint256 todaySent = dailyVolume[today][msg.sender];
        if (todaySent + amount > dailyLimit) {
            revert DailyLimitExceeded(amount, dailyLimit - todaySent);
        }

        // ── EFFECTS ─────────────────────────────
        uint256 feeAmount = (amount * feeBasisPoints) / 10_000;
        uint256 netAmount = amount - feeAmount;

        unchecked { ++_remittanceCounter; }
        remittanceId = _remittanceCounter;

        remittances[remittanceId] = Remittance({
            sender:        msg.sender,
            amount:        netAmount,
            feeAmount:     feeAmount,
            clabeHash:     clabeHash,
            recipientHash: recipientHash,
            createdAt:     uint64(block.timestamp),
            resolvedAt:    0,
            status:        RemittanceStatus.Pending
        });

        senderRemittances[msg.sender].push(remittanceId);
        dailyVolume[today][msg.sender] = todaySent + amount;
        totalVolumeSent += netAmount;
        totalFeesCollected += feeAmount;

        // ── INTERACTIONS ─────────────────────────
        // Pull full amount from sender
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Immediately forward fee to treasury
        if (feeAmount > 0) {
            usdc.safeTransfer(treasury, feeAmount);
        }

        emit RemittanceSent(
            remittanceId,
            msg.sender,
            netAmount,
            feeAmount,
            clabeHash,
            recipientHash,
            uint64(block.timestamp)
        );
    }

    // ─────────────────────────────────────────────
    // RELAYER: CONFIRM DELIVERY
    // ─────────────────────────────────────────────

    /**
     * @notice Marks a remittance as delivered after SPEI confirmation.
     * @dev Only callable by authorized relayers (backend wallets).
     *      This closes the on-chain proof of delivery loop.
     *
     * @param remittanceId   The remittance to mark as delivered
     * @param speiReference  Banxico SPEI reference number (off-chain proof)
     * @param mxnAmount      MXN amount in cents that was actually deposited
     */
    function confirmDelivery(
        uint256 remittanceId,
        string calldata speiReference,
        uint256 mxnAmount
    )
        external
        onlyRelayer
        remittanceExists(remittanceId)
    {
        Remittance storage r = remittances[remittanceId];

        if (r.status != RemittanceStatus.Pending && r.status != RemittanceStatus.Processing) {
            revert InvalidStatusTransition(remittanceId, r.status, RemittanceStatus.Pending);
        }

        r.status     = RemittanceStatus.Delivered;
        r.resolvedAt = uint64(block.timestamp);

        // USDC for this remittance was already in the contract;
        // it gets swept to the off-ramp hot wallet via withdrawForSettlement()
        // before this confirmation is called.

        emit RemittanceDelivered(remittanceId, speiReference, mxnAmount, msg.sender);
    }

    /**
     * @notice Updates status to Processing (called when Bitso API call is made).
     * @dev Prevents double-processing by moving status forward.
     */
    function markProcessing(uint256 remittanceId)
        external
        onlyRelayer
        remittanceExists(remittanceId)
    {
        Remittance storage r = remittances[remittanceId];
        if (r.status != RemittanceStatus.Pending) {
            revert InvalidStatusTransition(remittanceId, r.status, RemittanceStatus.Pending);
        }
        r.status = RemittanceStatus.Processing;
    }

    // ─────────────────────────────────────────────
    // RELAYER: REFUND
    // ─────────────────────────────────────────────

    /**
     * @notice Refunds USDC to the original sender if the remittance fails.
     * @dev Refunds net amount (fee is not returned — fee covers processing costs).
     *      Reason string is emitted for transparency and user notification.
     *
     * @param remittanceId  The remittance to refund
     * @param reason        Why the refund is being issued (e.g., "SPEI_REJECTED", "CLABE_INVALID")
     */
    function refund(
        uint256 remittanceId,
        string calldata reason
    )
        external
        onlyRelayer
        nonReentrant
        remittanceExists(remittanceId)
    {
        Remittance storage r = remittances[remittanceId];

        if (r.status != RemittanceStatus.Pending && r.status != RemittanceStatus.Processing) {
            revert InvalidStatusTransition(remittanceId, r.status, RemittanceStatus.Pending);
        }

        // ── EFFECTS ─────────────────────────────
        r.status     = RemittanceStatus.Refunded;
        r.resolvedAt = uint64(block.timestamp);

        // ── INTERACTIONS ─────────────────────────
        // Return net amount to sender (fee was already sent to treasury)
        usdc.safeTransfer(r.sender, r.amount);

        emit RemittanceRefunded(remittanceId, reason, msg.sender);
    }

    // ─────────────────────────────────────────────
    // RELAYER: WITHDRAW FOR SETTLEMENT
    // ─────────────────────────────────────────────

    /**
     * @notice Withdraws USDC from the contract to the off-ramp hot wallet.
     * @dev Called by backend before triggering Bitso API.
     *      Only moves funds for remittances in Pending or Processing status.
     *      The hot wallet then sends USDC to Bitso for conversion.
     *
     * @param remittanceId  The remittance being settled
     * @param hotWallet     Address of the off-ramp hot wallet
     */
    function withdrawForSettlement(
        uint256 remittanceId,
        address hotWallet
    )
        external
        onlyRelayer
        nonReentrant
        remittanceExists(remittanceId)
    {
        if (hotWallet == address(0)) revert ZeroAddress();

        Remittance storage r = remittances[remittanceId];
        if (r.status != RemittanceStatus.Pending && r.status != RemittanceStatus.Processing) {
            revert InvalidStatusTransition(remittanceId, r.status, RemittanceStatus.Pending);
        }

        usdc.safeTransfer(hotWallet, r.amount);
    }

    // ─────────────────────────────────────────────
    // VIEWS
    // ─────────────────────────────────────────────

    /// @notice Returns the full remittance struct for a given ID
    function getRemittance(uint256 id) external view returns (Remittance memory) {
        return remittances[id];
    }

    /// @notice Returns all remittance IDs for a sender
    function getSenderRemittances(address sender) external view returns (uint256[] memory) {
        return senderRemittances[sender];
    }

    /// @notice Total number of remittances ever created
    function totalRemittances() external view returns (uint256) {
        return _remittanceCounter;
    }

    /// @notice Current USDC balance held in contract (pending settlements)
    function pendingBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Compute fee for a given amount
    function computeFee(uint256 amount) external view returns (uint256 fee, uint256 net) {
        fee = (amount * feeBasisPoints) / 10_000;
        net = amount - fee;
    }

    /// @notice How much a sender can still send today
    function remainingDailyAllowance(address sender) external view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        uint256 sent = dailyVolume[today][sender];
        return sent >= dailyLimit ? 0 : dailyLimit - sent;
    }

    // ─────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────

    /// @notice Pause all new remittances (emergency stop)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume operations
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Add or remove an authorized relayer
    function setRelayer(address relayer, bool authorized) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        isRelayer[relayer] = authorized;
        emit RelayerUpdated(relayer, authorized);
    }

    /// @notice Update protocol fee (max 5% = 500 bps)
    function setFee(uint256 newFeeBasisPoints) external onlyOwner {
        if (newFeeBasisPoints > 500) revert FeeTooHigh(newFeeBasisPoints, 500);
        emit FeeUpdated(feeBasisPoints, newFeeBasisPoints);
        feeBasisPoints = newFeeBasisPoints;
    }

    /// @notice Update transaction and daily limits
    function setLimits(
        uint256 _minAmount,
        uint256 _maxAmount,
        uint256 _dailyLimit
    ) external onlyOwner {
        require(_minAmount > 0 && _maxAmount > _minAmount && _dailyLimit >= _maxAmount, "Invalid limits");
        minAmount  = _minAmount;
        maxAmount  = _maxAmount;
        dailyLimit = _dailyLimit;
        emit LimitsUpdated(_minAmount, _maxAmount, _dailyLimit);
    }

    /// @notice Update treasury address
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
