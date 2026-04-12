import { createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { metaMask } from 'wagmi/connectors';

const isMainnet = process.env.NEXT_PUBLIC_NETWORK === 'mainnet';

const rpcUrl = process.env.NEXT_PUBLIC_BASE_RPC_URL
  ?? (isMainnet ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

export const activeChain = isMainnet ? base : baseSepolia;

export const wagmiConfig = createConfig({
  chains:     [activeChain],
  connectors: [metaMask()],
  transports: {
    [base.id]:        http(isMainnet ? rpcUrl : undefined),
    [baseSepolia.id]: http(isMainnet ? undefined : rpcUrl),
  },
  ssr: true,
});

// Contract addresses
export const CONTRACT_ADDRESS = (
  process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? '0x0000000000000000000000000000000000000000'
) as `0x${string}`;

// USDC on Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
// USDC on Base mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export const USDC_ADDRESS = (
  process.env.NEXT_PUBLIC_USDC_ADDRESS
    ?? (isMainnet
      ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      : '0x036CbD53842c5426634e7929541eC2318f3dCF7e')
) as `0x${string}`;

export const BASESCAN_URL =
  process.env.NEXT_PUBLIC_BASESCAN_URL
    ?? (isMainnet ? 'https://basescan.org' : 'https://sepolia.basescan.org');
