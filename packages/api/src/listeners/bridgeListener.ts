import { createPublicClient, http, parseAbiItem } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { logger } from '../services/logger';
import { processRemittance } from '../jobs/remittanceQueue';

// ── CONFIGURACIÓN ─────────────────────────────────────
const isMainnet = process.env.NETWORK === 'mainnet';

const chain = isMainnet ? base : baseSepolia;
const rpcUrl = isMainnet
  ? (process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org')
  : (process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org');

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}`;

// ── ABI DEL EVENTO ────────────────────────────────────
const REMITTANCE_SENT_EVENT = parseAbiItem(
  'event RemittanceSent(uint256 indexed remittanceId, address indexed sender, uint256 amount, uint256 feeAmount, bytes32 indexed clabeHash, bytes32 recipientHash, uint64 timestamp)'
);

// ── CLIENTE VIEM (read-only) ──────────────────────────
const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
});

// ── LISTENER PRINCIPAL ────────────────────────────────
export async function startBridgeListener(): Promise<void> {
  if (!CONTRACT_ADDRESS) {
    logger.warn('CONTRACT_ADDRESS not set — bridge listener disabled');
    return;
  }

  logger.info({ contract: CONTRACT_ADDRESS, network: chain.name }, 'Starting bridge listener');

  // Escucha eventos en tiempo real (websocket-like polling)
  publicClient.watchContractEvent({
    address: CONTRACT_ADDRESS,
    abi: [REMITTANCE_SENT_EVENT],
    eventName: 'RemittanceSent',
    onLogs: async (logs) => {
      for (const log of logs) {
        const { remittanceId, sender, amount, feeAmount, clabeHash, recipientHash, timestamp } =
          log.args;

        logger.info(
          {
            remittanceId: remittanceId?.toString(),
            sender,
            amount: amount?.toString(),
            txHash: log.transactionHash,
          },
          'RemittanceSent event detected'
        );

        // Encola el job para procesar el off-ramp
        await processRemittance({
          remittanceId:  remittanceId!.toString(),
          sender:        sender!,
          amount:        amount!.toString(),
          feeAmount:     feeAmount!.toString(),
          clabeHash:     clabeHash!,
          recipientHash: recipientHash!,
          timestamp:     Number(timestamp),
          txHash:        log.transactionHash!,
          blockNumber:   log.blockNumber!.toString(),
        });
      }
    },
    onError: (error) => {
      logger.error({ error }, 'Bridge listener error');
    },
  });
}