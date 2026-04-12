// ── RemexBridge ABI (relevant functions only) ─────────
// Full ABI: packages/contracts/artifacts/contracts/RemexBridge.sol/RemexBridge.json

export const REMEX_BRIDGE_ABI = [
  {
    name: 'sendRemittance',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount',        type: 'uint256' },
      { name: 'clabeHash',     type: 'bytes32' },
      { name: 'recipientHash', type: 'bytes32' },
    ],
    outputs: [{ name: 'remittanceId', type: 'uint256' }],
  },
  {
    name: 'computeFee',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'amount', type: 'uint256' }],
    outputs: [
      { name: 'fee', type: 'uint256' },
      { name: 'net', type: 'uint256' },
    ],
  },
  {
    name: 'feeBasisPoints',
    type: 'function',
    stateMutability: 'view',
    inputs:  [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'remainingDailyAllowance',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'sender', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'paused',
    type: 'function',
    stateMutability: 'view',
    inputs:  [],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'RemittanceSent',
    type: 'event',
    inputs: [
      { name: 'remittanceId',  type: 'uint256', indexed: true },
      { name: 'sender',        type: 'address', indexed: true },
      { name: 'amount',        type: 'uint256', indexed: false },
      { name: 'feeAmount',     type: 'uint256', indexed: false },
      { name: 'clabeHash',     type: 'bytes32', indexed: true },
      { name: 'recipientHash', type: 'bytes32', indexed: false },
      { name: 'timestamp',     type: 'uint256', indexed: false },
    ],
  },
] as const;

// ── ERC-20 ABI (USDC — approve + allowance + balanceOf) ──

export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;
