import { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { getDB } from '../db/client';
import { KYC_TIER_LIMITS } from '../plugins/auth';
import { encrypt } from '../services/crypto';
import { logger } from '../services/logger';

// ── SCHEMAS ───────────────────────────────────────────

const GetTransferParams = z.object({
  id: z.string().min(1),
});

const ListTransfersQuery = z.object({
  sender: z.string().optional(),
  status: z.enum(['pending', 'processing', 'delivered', 'refunded']).optional(),
  limit:  z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

// ── ROUTES ────────────────────────────────────────────

export async function transferRoutes(server: FastifyInstance) {
  const db = getDB();

  // ── GET /:id ─────────────────────────────────────
  // Requiere auth; sólo puede ver sus propias remesas (excepto admin, futuro).
  server.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [server.authenticate] },
    async (request, reply) => {
      const { id } = GetTransferParams.parse(request.params);
      const [remittance] = await db`
        SELECT r.*
        FROM remittances r
        JOIN users u ON u.id = r.user_id
        WHERE r.remittance_id = ${id}
          AND u.wallet_address = ${request.user.wallet}
      `;
      if (!remittance) {
        return reply.status(404).send({ error: 'Remittance not found' });
      }
      return reply.send({ data: remittance });
    },
  );

  // ── GET / ─────────────────────────────────────────
  // Lista remesas del usuario autenticado.
  server.get(
    '/',
    { preHandler: [server.authenticate] },
    async (request, reply) => {
      let status: string | undefined, limit: number, offset: number;
      try {
        ({ status, limit, offset } = ListTransfersQuery.parse(request.query));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation error', issues: err.issues });
        }
        throw err;
      }
      const { wallet } = request.user;

      const remittances = status
        ? await db`
            SELECT r.*
            FROM remittances r
            JOIN users u ON u.id = r.user_id
            WHERE u.wallet_address = ${wallet}
              AND r.status = ${status}
            ORDER BY r.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : await db`
            SELECT r.*
            FROM remittances r
            JOIN users u ON u.id = r.user_id
            WHERE u.wallet_address = ${wallet}
            ORDER BY r.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `;

      return reply.send({ data: remittances, limit, offset });
    },
  );

  // ── GET /:id/status ──────────────────────────────
  server.get<{ Params: { id: string } }>(
    '/:id/status',
    { preHandler: [server.authenticate] },
    async (request, reply) => {
      const { id } = GetTransferParams.parse(request.params);
      const [row] = await db`
        SELECT r.remittance_id, r.status, r.spei_reference,
               r.mxn_amount, r.fx_rate, r.resolved_at
        FROM remittances r
        JOIN users u ON u.id = r.user_id
        WHERE r.remittance_id = ${id}
          AND u.wallet_address = ${request.user.wallet}
      `;
      if (!row) {
        return reply.status(404).send({ error: 'Remittance not found' });
      }
      return reply.send({ data: row });
    },
  );

  // ── POST /recipient-info ─────────────────────────
  // El frontend llama este endpoint ANTES de firmar el tx on-chain.
  // Guarda el teléfono del receptor (cifrado AES-256-GCM) vinculado al clabeHash.
  // Cuando el worker procesa el evento on-chain, recupera el teléfono para WhatsApp.
  server.post(
    '/recipient-info',
    { preHandler: [server.requireKYC] },
    async (request, reply) => {
      let clabeHash: string, recipientPhone: string;
      try {
        ({ clabeHash, recipientPhone } = z.object({
          clabeHash:      z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid clabeHash (bytes32 hex)'),
          recipientPhone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Invalid E.164 phone number'),
        }).parse(request.body));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation error', issues: err.issues });
        }
        throw err;
      }

      const { sub } = request.user;

      let phoneEnc: string;
      try {
        phoneEnc = encrypt(recipientPhone);
      } catch (err) {
        logger.error({ err }, 'recipient-info: encryption failed — NOTIFICATION_ENCRYPTION_KEY misconfigured?');
        return reply.status(500).send({ error: 'Encryption unavailable' });
      }

      await db`
        INSERT INTO recipient_contacts (clabe_hash, phone_enc, registered_by)
        VALUES (${clabeHash}, ${phoneEnc}, ${sub})
        ON CONFLICT (clabe_hash, registered_by)
          DO UPDATE SET phone_enc = EXCLUDED.phone_enc
      `;

      logger.info({ userId: sub, clabeHash }, 'Recipient contact registered');
      return reply.status(201).send({ registered: true });
    },
  );

  // ── POST /check-limit ────────────────────────────
  // Verifica si el usuario puede enviar el monto dado (FinCEN MSB).
  // El contrato on-chain también valida, pero esta ruta da feedback previo al usuario.
  server.post(
    '/check-limit',
    { preHandler: [server.requireKYC] },
    async (request, reply) => {
      let body: { amountUsd: number };
      try {
        body = z.object({ amountUsd: z.number().positive() }).parse(request.body);
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: 'Validation error', issues: err.issues });
        }
        throw err;
      }
      const { sub, wallet } = request.user;

      const [user] = await db<{
        transaction_tier: string;
        daily_sent_usd:   string;
        daily_reset_at:   string | null;
      }[]>`
        SELECT transaction_tier, daily_sent_usd, daily_reset_at
        FROM users WHERE id = ${sub}
      `;

      if (!user) return reply.status(404).send({ error: 'User not found' });

      const today        = new Date().toISOString().slice(0, 10);
      const needsReset   = user.daily_reset_at !== today;
      const dailySentUsd = needsReset ? 0 : Number(user.daily_sent_usd);
      const limit        = KYC_TIER_LIMITS[user.transaction_tier] ?? 500;
      const remaining    = limit - dailySentUsd;
      const allowed      = body.amountUsd <= remaining;

      // FinCEN: log intent para trazabilidad
      logger.info(
        { userId: sub, wallet, amountUsd: body.amountUsd, dailySentUsd, limit, allowed },
        'Transfer limit check',
      );

      return reply.send({
        allowed,
        amountUsd:   body.amountUsd,
        dailySentUsd,
        dailyLimit:  limit,
        remaining,
        tier:        user.transaction_tier,
      });
    },
  );
}
