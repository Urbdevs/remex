// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUSDC
 * @notice Test double for USDC. 6 decimals, freely mintable in test environment.
 * @dev Never deploy to mainnet.
 */
contract MockUSDC is ERC20, Ownable {
    constructor() ERC20("USD Coin", "USDC") Ownable(msg.sender) {}

    /// @notice USDC uses 6 decimals (not 18)
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint any amount to any address for testing
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Convenience: mint 1000 USDC to caller
    function faucet() external {
        _mint(msg.sender, 1000 * 1e6);
    }
}
