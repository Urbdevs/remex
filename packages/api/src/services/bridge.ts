import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { logger } from './logger';

// ── CONFIGURACIÓN ─────────────────────────────────────
const isMainnet = process.env.NETWORK === 'mainnet';
const chain     = isMainnet ? base : baseSepolia;
const rpcUrl    = isMainnet
  ? (process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org')
  : (process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org');

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}`;

// ── ABI (solo las funciones que usa el backend) ───────
const BRIDGE_ABI = parseAbi([
  'function markProcessing(uint256 remittanceId) external',
  'function confirmDelivery(uint256 remittanceId, string calldata speiReference, uint256 mxnAmount) external',
  'function refund(uint256 remittanceId, string calldata reason) external',
  'function withdrawForSettlement(uint256 remittanceId, address hotWallet) external',
  'function getRemittance(uint256 id) external view returns (tuple(address sender, uint256 amount, uint256 feeAmount, bytes32 clabeHash, bytes32 recipientHash, uint64 createdAt, uint64 resolvedAt, uint8 status))',
]);

// ── CLIENTE CON WALLET (para escribir al contrato) ────
class BridgeService {
  private walletClient;
  private publicClient;

  constructor() {
    const relayerKey = process.env.RELAYER_PRIVATE_KEY as `0x${string}`;

    if (!relayerKey) {
      logger.warn('RELAYER_PRIVATE_KEY not set — bridge write operations disabled');
    }

    const account = relayerKey
      ? privateKeyToAccount(relayerKey)
      : privateKeyToAccount(('0x' + '1'.padStart(64, '0')) as `0x${string}`);

    this.walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
  }

  // ── MARK PROCESSING ───────────────────────────────
  async markProcessing(remittanceId: string): Promise<string> {
    logger.info({ remittanceId }, 'Marking remittance as Processing on-chain');

    const hash = await this.walletClient.writeContract({
      address: CONTRACT_ADDRESS,
      abi:     BRIDGE_ABI,
      functionName: 'markProcessing',
      args:    [BigInt(remittanceId)],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    logger.info({ remittanceId, hash }, 'markProcessing confirmed');
    return hash;
  }

  // ── CONFIRM DELIVERY ──────────────────────────────
  async confirmDelivery(
    remittanceId:  string,
    speiReference: string,
    mxnAmount:     number
  ): Promise<string> {
    logger.info({ remittanceId, speiReference }, 'Confirming delivery on-chain');

    const mxnCents = BigInt(Math.round(mxnAmount * 100));

    const hash = await this.walletClient.writeContract({
      address: CONTRACT_ADDRESS,
      abi:     BRIDGE_ABI,
      functionName: 'confirmDelivery',
      args:    [BigInt(remittanceId), speiReference, mxnCents],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    logger.info({ remittanceId, hash }, 'Delivery confirmed on-chain');
    return hash;
  }

  // ── REFUND ────────────────────────────────────────
  async refund(remittanceId: string, reason: string): Promise<string> {
    logger.warn({ remittanceId, reason }, 'Issuing refund on-chain');

    const hash = await this.walletClient.writeContract({
      address: CONTRACT_ADDRESS,
      abi:     BRIDGE_ABI,
      functionName: 'refund',
      args:    [BigInt(remittanceId), reason],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // ── GET REMITTANCE (read) ─────────────────────────
  async getRemittance(remittanceId: string) {
    return this.publicClient.readContract({
      address:      CONTRACT_ADDRESS,
      abi:          BRIDGE_ABI,
      functionName: 'getRemittance',
      args:         [BigInt(remittanceId)],
    });
  }
}

export const bridgeService = new BridgeService();