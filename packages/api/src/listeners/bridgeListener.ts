import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { logger } from '../services/logger';
import { processRemittance } from '../jobs/remittanceQueue';

const POLLING_INTERVAL_MS = 4_000;

const REMITTANCE_SENT_EVENT = parseAbiItem(
  'event RemittanceSent(uint256 indexed remittanceId, address indexed sender, uint256 amount, uint256 feeAmount, bytes32 indexed clabeHash, bytes32 recipientHash, uint64 timestamp)'
);

export async function startBridgeListener(): Promise<void> {
  const contractAddress = process.env.CONTRACT_ADDRESS as `0x${string}`;
  if (!contractAddress) {
    logger.warn('CONTRACT_ADDRESS not set — bridge listener disabled');
    return;
  }

  const rpcUrl = process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org';
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  // Arranca desde el bloque actual — no reprocesa historia
  let fromBlock = await client.getBlockNumber();

  logger.info(
    { contract: contractAddress, network: base.name, fromBlock: fromBlock.toString() },
    'Starting bridge listener',
  );

  const poll = async () => {
    try {
      const toBlock = await client.getBlockNumber();
      if (toBlock < fromBlock) return;

      const logs = await client.getLogs({
        address:   contractAddress,
        event:     REMITTANCE_SENT_EVENT,
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        const { remittanceId, sender, amount, feeAmount, clabeHash, recipientHash, timestamp } =
          log.args;

        logger.info(
          {
            remittanceId: remittanceId?.toString(),
            sender,
            amount:       amount?.toString(),
            txHash:       log.transactionHash,
          },
          'RemittanceSent event detected',
        );

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

      fromBlock = toBlock + 1n;
    } catch (err) {
      logger.error({ err }, 'Bridge listener poll error');
    }
  };

  // Primer poll inmediato, luego cada 4s secuencialmente (sin solapamiento)
  const scheduleNext = () =>
    setTimeout(async () => {
      await poll();
      scheduleNext();
    }, POLLING_INTERVAL_MS);

  await poll();
  scheduleNext();
}
