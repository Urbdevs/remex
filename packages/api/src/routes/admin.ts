import { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { getDB } from '../db/client';
import { remittanceQueue } from '../jobs/remittanceQueue';
import { logger } from '../services/logger';

// ── SCHEMAS ───────────────────────────────────────────

const MetricsQuery = z.object({
  // Fecha en formato YYYY-MM-DD. Por defecto: hoy (UTC).
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const RemittancesQuery = z.object({
  status:   z.enum(['pending', 'processing', 'delivered', 'refunded']).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sender:   z.string().optional(),
  limit:    z.coerce.number().min(1).max(200).default(50),
  offset:   z.coerce.number().min(0).default(0),
});

const StuckQuery = z.object({
  // Umbral en minutos. Por defecto: 15.
  thresholdMinutes: z.coerce.number().min(1).max(1440).default(15),
});

// ── TIPOS DE RESPUESTA ────────────────────────────────

interface DailyMetrics {
  date:            string;
  total:           number;
  delivered:       number;
  refunded:        number;
  processing:      number;
  pending:         number;
  volumeUsdc:      number;
  volumeMxn:       number;
  feesUsdc:        number;
  successRatePct:  number | null;
  avgFxRate:       number | null;
}

interface HourlyBucket {
  hour:       string;
  total:      number;
  delivered:  number;
  volumeUsdc: number;
}

interface StuckRemittance {
  remittanceId:  string;
  sender:        string;
  amountUsdc:    number;
  mxnAmount:     number | null;
  minutesStuck:  number;
  updatedAt:     string;
  txHash:        string;
}

// ── ROUTES ────────────────────────────────────────────

export async function adminRoutes(server: FastifyInstance) {
  const db = getDB();

  // ── GET /v1/admin/metrics ─────────────────────────
  // Métricas del día: volumen, fees, tasa de éxito, conteo por estado.
  // Acepta ?date=YYYY-MM-DD para consultar días históricos.
  server.get(
    '/metrics',
    { preHandler: [server.requireAdmin] },
    async (request, reply) => {
      let date: string;
      try {
        ({ date = new Date().toISOString().slice(0, 10) } =
          MetricsQuery.parse(request.query));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation error', issues: err.issues });
        }
        throw err;
      }

      const [row] = await db<{
        total:           string;
        delivered:       string;
        refunded:        string;
        processing:      string;
        pending:         string;
        volume_usdc:     string | null;
        volume_mxn:      string | null;
        fees_usdc:       string | null;
        success_rate:    string | null;
        avg_fx_rate:     string | null;
      }[]>`
        SELECT
          COUNT(*)                                                       AS total,
          COUNT(*) FILTER (WHERE status = 'delivered')                   AS delivered,
          COUNT(*) FILTER (WHERE status = 'refunded')                    AS refunded,
          COUNT(*) FILTER (WHERE status = 'processing')                  AS processing,
          COUNT(*) FILTER (WHERE status = 'pending')                     AS pending,
          COALESCE(SUM(amount_usdc::numeric) / 1000000, 0)              AS volume_usdc,
          COALESCE(SUM(CASE WHEN status = 'delivered' THEN mxn_amount ELSE 0 END), 0)
                                                                         AS volume_mxn,
          COALESCE(SUM(fee_usdc::numeric) / 1000000, 0)                 AS fees_usdc,
          ROUND(
            COUNT(*) FILTER (WHERE status = 'delivered')::numeric
            / NULLIF(
                COUNT(*) FILTER (WHERE status IN ('delivered', 'refunded')),
                0
              ) * 100,
            2
          )                                                              AS success_rate,
          ROUND(AVG(fx_rate) FILTER (WHERE fx_rate IS NOT NULL), 4)     AS avg_fx_rate
        FROM remittances
        WHERE created_at >= ${date}::date
          AND created_at <  (${date}::date + INTERVAL '1 day')
      `;

      const metrics: DailyMetrics = {
        date,
        total:          Number(row.total),
        delivered:      Number(row.delivered),
        refunded:       Number(row.refunded),
        processing:     Number(row.processing),
        pending:        Number(row.pending),
        volumeUsdc:     Number(row.volume_usdc  ?? 0),
        volumeMxn:      Number(row.volume_mxn   ?? 0),
        feesUsdc:       Number(row.fees_usdc    ?? 0),
        successRatePct: row.success_rate  ? Number(row.success_rate)  : null,
        avgFxRate:      row.avg_fx_rate   ? Number(row.avg_fx_rate)   : null,
      };

      logger.info({ date, total: metrics.total }, 'Admin metrics requested');
      return reply.send({ data: metrics });
    },
  );

  // ── GET /v1/admin/metrics/history ─────────────────
  // Desglose horario de las últimas 24 horas para gráficas del dashboard.
  server.get(
    '/metrics/history',
    { preHandler: [server.requireAdmin] },
    async (_request, reply) => {
      const rows = await db<{
        hour:       string;
        total:      string;
        delivered:  string;
        volume_usdc: string;
      }[]>`
        SELECT
          to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour,
          COUNT(*)                                                                AS total,
          COUNT(*) FILTER (WHERE status = 'delivered')                           AS delivered,
          COALESCE(SUM(amount_usdc::numeric) / 1000000, 0)                       AS volume_usdc
        FROM remittances
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY date_trunc('hour', created_at)
        ORDER BY date_trunc('hour', created_at)
      `;

      const history: HourlyBucket[] = rows.map((r) => ({
        hour:       r.hour,
        total:      Number(r.total),
        delivered:  Number(r.delivered),
        volumeUsdc: Number(r.volume_usdc),
      }));

      return reply.send({ data: history });
    },
  );

  // ── GET /v1/admin/remittances ─────────────────────
  // Tabla de remesas con filtros y paginación.
  // Filtros: status, dateFrom (inclusive), dateTo (exclusive), sender (wallet).
  server.get(
    '/remittances',
    { preHandler: [server.requireAdmin] },
    async (request, reply) => {
      let parsed: z.infer<typeof RemittancesQuery>;
      try {
        parsed = RemittancesQuery.parse(request.query);
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation error', issues: err.issues });
        }
        throw err;
      }

      const { status, dateFrom, dateTo, sender, limit, offset } = parsed;

      // Parámetros nullable: cuando son NULL, la condición se vuelve siempre true
      // gracias a "X IS NULL OR col = X". Evita fragments dinámicos que complican
      // el mock en tests y la legibilidad de la query.
      const statusParam   = status             ?? null;
      const dateFromParam = dateFrom           ?? null;
      const dateToParam   = dateTo             ?? null;
      const senderParam   = sender             ? sender.toLowerCase() : null;

      const rows = await db`
        SELECT
          remittance_id,
          sender,
          amount_usdc::numeric / 1000000   AS amount_usdc,
          fee_usdc::numeric    / 1000000   AS fee_usdc,
          status,
          fx_rate,
          mxn_amount,
          spei_reference,
          error_message,
          tx_hash,
          block_number,
          created_at,
          resolved_at,
          updated_at
        FROM remittances
        WHERE (${statusParam}   IS NULL OR status      =  ${statusParam})
          AND (${dateFromParam} IS NULL OR created_at  >= ${dateFromParam}::date)
          AND (${dateToParam}   IS NULL OR created_at  <  ${dateToParam}::date)
          AND (${senderParam}   IS NULL OR sender       = ${senderParam})
        ORDER BY created_at DESC
        LIMIT  ${limit}
        OFFSET ${offset}
      `;

      const [countRow] = await db<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM remittances
        WHERE (${statusParam}   IS NULL OR status      =  ${statusParam})
          AND (${dateFromParam} IS NULL OR created_at  >= ${dateFromParam}::date)
          AND (${dateToParam}   IS NULL OR created_at  <  ${dateToParam}::date)
          AND (${senderParam}   IS NULL OR sender       = ${senderParam})
      `;

      return reply.send({
        data:   rows,
        total:  Number(countRow.count),
        limit,
        offset,
      });
    },
  );

  // ── GET /v1/admin/stuck ───────────────────────────
  // Remesas atascadas en status 'processing' por más de N minutos.
  // Alerta operacional: el worker puede haber fallado silenciosamente.
  server.get(
    '/stuck',
    { preHandler: [server.requireAdmin] },
    async (request, reply) => {
      let thresholdMinutes: number;
      try {
        ({ thresholdMinutes } = StuckQuery.parse(request.query));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation error', issues: err.issues });
        }
        throw err;
      }

      const rows = await db<{
        remittance_id: string;
        sender:        string;
        amount_usdc:   string;
        mxn_amount:    string | null;
        minutes_stuck: string;
        updated_at:    string;
        tx_hash:       string;
      }[]>`
        SELECT
          remittance_id,
          sender,
          amount_usdc::numeric / 1000000                        AS amount_usdc,
          mxn_amount,
          ROUND(
            EXTRACT(EPOCH FROM (NOW() - updated_at)) / 60, 1
          )                                                      AS minutes_stuck,
          updated_at,
          tx_hash
        FROM remittances
        WHERE status    = 'processing'
          AND updated_at < NOW() - (${thresholdMinutes} * INTERVAL '1 minute')
        ORDER BY updated_at ASC
      `;

      const stuck: StuckRemittance[] = rows.map((r) => ({
        remittanceId: r.remittance_id,
        sender:       r.sender,
        amountUsdc:   Number(r.amount_usdc),
        mxnAmount:    r.mxn_amount ? Number(r.mxn_amount) : null,
        minutesStuck: Number(r.minutes_stuck),
        updatedAt:    r.updated_at,
        txHash:       r.tx_hash,
      }));

      if (stuck.length > 0) {
        logger.warn(
          { count: stuck.length, thresholdMinutes },
          'Admin alert: stuck remittances detected',
        );
      }

      return reply.send({
        data:             stuck,
        count:            stuck.length,
        thresholdMinutes,
        alerting:         stuck.length > 0,
      });
    },
  );

  // ── GET /v1/admin/queue ───────────────────────────
  // Estado de la cola BullMQ: jobs en espera, activos, completados, fallidos.
  // Útil para detectar acumulación de jobs no procesados.
  server.get(
    '/queue',
    { preHandler: [server.requireAdmin] },
    async (_request, reply) => {
      const counts = await remittanceQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused',
      );

      const isPaused = await remittanceQueue.isPaused();

      return reply.send({
        data: {
          name:    remittanceQueue.name,
          counts,
          isPaused,
          // Señal de alerta: jobs fallidos sin resolver o acumulación en espera
          alerts: {
            highWaiting: counts.waiting  > 50,
            highFailed:  counts.failed   > 10,
            workerDown:  counts.active   === 0 && counts.waiting > 0,
          },
        },
      });
    },
  );
}
