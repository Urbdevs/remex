import { Queue, Worker, Job } from 'bullmq';
import { logger } from '../services/logger';
import { bitsoService } from '../services/bitso';
import { bridgeService } from '../services/bridge';
import { dispatchNotifications } from '../services/notifications';
import { getDB } from '../db/client';

// ── TIPOS ─────────────────────────────────────────────
export interface RemittanceJob {
  remittanceId:  string;
  sender:        string;
  amount:        string;  // USDC en 6 decimales
  feeAmount:     string;
  clabeHash:     string;
  recipientHash: string;
  timestamp:     number;
  txHash:        string;
  blockNumber:   string;
}

// ── REDIS CONNECTION ──────────────────────────────────
const connection = {
  host:     process.env.REDIS_HOST     ?? 'localhost',
  port:     Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
};

// ── QUEUE ─────────────────────────────────────────────
export const remittanceQueue = new Queue<RemittanceJob>('remittances', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s
    removeOnComplete: false,
    removeOnFail: false,
  },
});

// ── WORKER ────────────────────────────────────────────
export const remittanceWorker = new Worker<RemittanceJob>(
  'remittances',
  async (job: Job<RemittanceJob>) => {
    const { remittanceId, amount, clabeHash, txHash } = job.data;
    const db = getDB();

    logger.info({ remittanceId, jobId: job.id }, 'Processing remittance job');

    // ── STEP 1: Guardar en DB ────────────────────────
    await job.updateProgress(10);
    await db`
      INSERT INTO remittances (
        remittance_id, sender, amount_usdc, fee_usdc,
        clabe_hash, recipient_hash, tx_hash, block_number, status
      ) VALUES (
        ${remittanceId}, ${job.data.sender}, ${amount}, ${job.data.feeAmount},
        ${clabeHash}, ${job.data.recipientHash}, ${txHash}, ${job.data.blockNumber},
        'pending'
      )
      ON CONFLICT (remittance_id) DO NOTHING
    `;

    // ── STEP 2: Marcar como Processing on-chain ──────
    await job.updateProgress(20);
    await bridgeService.markProcessing(remittanceId);

    // ── STEP 3: Obtener quote FX de Bitso ────────────
    await job.updateProgress(40);
    const usdcAmount = Number(amount) / 1_000_000;
    const quote = await bitsoService.getFXQuote(usdcAmount);

    logger.info(
      { remittanceId, usdcAmount, mxnAmount: quote.mxnAmount, rate: quote.rate },
      'FX quote obtained',
    );

    // ── STEP 4: Actualizar DB con quote + estado processing ──
    await db`
      UPDATE remittances
      SET fx_rate = ${quote.rate}, mxn_amount = ${quote.mxnAmount}, status = 'processing'
      WHERE remittance_id = ${remittanceId}
    `;

    // ── STEP 4b: Notificar 'processing' (fire-and-forget) ────
    dispatchNotifications(remittanceId, 'processing').catch((err) =>
      logger.error({ err, remittanceId }, 'Notification dispatch error (processing)'),
    );

    // ── STEP 5: Ejecutar payout SPEI via Bitso ───────
    await job.updateProgress(60);
    const speiResult = await bitsoService.sendSPEIPayout({
      quoteId:   quote.quoteId,
      mxnAmount: quote.mxnAmount,
      clabeHash,
      reference: `REMEX-${remittanceId}`,
    });

    logger.info(
      { remittanceId, speiReference: speiResult.speiReference },
      'SPEI payout initiated',
    );

    // ── STEP 6: Confirmar on-chain ───────────────────
    await job.updateProgress(80);
    await bridgeService.confirmDelivery(
      remittanceId,
      speiResult.speiReference,
      quote.mxnAmount,
    );

    // ── STEP 7: Actualizar DB como entregado ─────────
    await job.updateProgress(100);
    await db`
      UPDATE remittances
      SET status         = 'delivered',
          spei_reference = ${speiResult.speiReference},
          resolved_at    = NOW()
      WHERE remittance_id = ${remittanceId}
    `;

    // ── STEP 7b: Notificar 'delivered' (fire-and-forget) ─────
    dispatchNotifications(remittanceId, 'delivered').catch((err) =>
      logger.error({ err, remittanceId }, 'Notification dispatch error (delivered)'),
    );

    logger.info({ remittanceId }, 'Remittance delivered successfully');
    return { speiReference: speiResult.speiReference, mxnAmount: quote.mxnAmount };
  },
  {
    connection,
    concurrency: 5,
  },
);

// ── EVENT HANDLERS ────────────────────────────────────
remittanceWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, remittanceId: job.data.remittanceId }, 'Job completed');
});

remittanceWorker.on('failed', async (job, err) => {
  logger.error({ jobId: job?.id, remittanceId: job?.data.remittanceId, err }, 'Job failed');

  // Si el job agotó todos sus reintentos, llamar refund() on-chain y notificar
  if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
    const db = getDB();

    // Llamar refund() en el contrato — devuelve USDC al sender
    bridgeService.refund(job.data.remittanceId, err.message.slice(0, 200)).catch((refundErr) =>
      logger.error({ refundErr, remittanceId: job.data.remittanceId }, 'On-chain refund() call failed'),
    );

    await db`
      UPDATE remittances
      SET status        = 'refunded',
          error_message = ${err.message},
          resolved_at   = NOW()
      WHERE remittance_id = ${job.data.remittanceId}
        AND status NOT IN ('delivered', 'refunded')
    `.catch((dbErr) =>
      logger.error({ dbErr, remittanceId: job.data.remittanceId }, 'Failed to mark refund in DB'),
    );

    dispatchNotifications(job.data.remittanceId, 'refunded').catch((notifErr) =>
      logger.error({ notifErr, remittanceId: job.data.remittanceId }, 'Notification dispatch error (refunded)'),
    );
  }
});

// ── ENCOLAR ───────────────────────────────────────────
export async function processRemittance(data: RemittanceJob): Promise<void> {
  await remittanceQueue.add(`remittance-${data.remittanceId}`, data, {
    jobId: `remittance-${data.remittanceId}`, // Idempotente
  });
  logger.info({ remittanceId: data.remittanceId }, 'Remittance queued');
}
