import { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import crypto from 'crypto';
import { verifyMessage } from 'viem';
import { getDB } from '../db/client';
import { storeNonce, consumeNonce } from '../services/redis';
import { logger } from '../services/logger';

// ── SCHEMAS ───────────────────────────────────────────

const NonceQuery = z.object({
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address'),
});

const VerifyBody = z.object({
  address:   z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signature: z.string().min(1),
  message:   z.string().min(1),
});

// ── SIWE MESSAGE BUILDER ──────────────────────────────

function buildSiweMessage(address: string, nonce: string): string {
  const issuedAt = new Date().toISOString();
  const chainId  = process.env.NETWORK === 'mainnet' ? 8453 : 84532; // Base / Base Sepolia

  return [
    `remex.mx wants you to sign in with your Ethereum account:`,
    address,
    ``,
    `Sign in to Remex — USA→México remittances`,
    ``,
    `URI: ${process.env.FRONTEND_URL ?? 'https://remex.mx'}`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

// ── ROUTES ────────────────────────────────────────────

export async function authRoutes(server: FastifyInstance) {
  const db = getDB();

  // ── GET /v1/auth/nonce ──────────────────────────
  // Genera un nonce único para el wallet address dado.
  // El cliente firma este nonce con su wallet (EIP-4361 SIWE).
  server.get('/nonce', async (request, reply) => {
    let address: string;
    try {
      ({ address } = NonceQuery.parse(request.query));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation error', issues: err.issues });
      }
      throw err;
    }
    const normalizedAddress = address.toLowerCase();

    const nonce   = crypto.randomBytes(16).toString('hex');
    const message = buildSiweMessage(address, nonce);

    await storeNonce(normalizedAddress, nonce);

    logger.info({ address: normalizedAddress }, 'Nonce generated');
    return reply.send({ nonce, message });
  });

  // ── POST /v1/auth/verify ───────────────────────
  // Verifica la firma SIWE y emite un JWT.
  // Crea el usuario si no existe (registro implícito).
  // Rate limit estricto: 10 req/min por IP (brute-force de wallets).
  server.post('/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    let address: string, signature: string, message: string;
    try {
      ({ address, signature, message } = VerifyBody.parse(request.body));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation error', issues: err.issues });
      }
      throw err;
    }
    const normalizedAddress = address.toLowerCase() as `0x${string}`;

    // ── 1. Extraer nonce del mensaje ────────────────
    // Exactamente 32 hex chars = crypto.randomBytes(16).toString('hex')
    const nonceMatch = message.match(/^Nonce: ([a-f0-9]{32})$/m);
    if (!nonceMatch) {
      return reply.status(400).send({ error: 'Invalid SIWE message format' });
    }
    const nonce = nonceMatch[1];

    // ── 2. Validar antigüedad del mensaje (≤5 min) ──
    // Previene replay de mensajes firmados con anterioridad.
    const issuedAtMatch = message.match(/^Issued At: (.+)$/m);
    if (!issuedAtMatch) {
      return reply.status(400).send({ error: 'Missing Issued At field' });
    }
    const issuedAt = new Date(issuedAtMatch[1]);
    if (isNaN(issuedAt.getTime()) || Date.now() - issuedAt.getTime() > 5 * 60 * 1000) {
      return reply.status(400).send({ error: 'Message expired or invalid Issued At' });
    }

    // ── 3. Consumir nonce (protección replay) ───────
    const validNonce = await consumeNonce(normalizedAddress, nonce);
    if (!validNonce) {
      return reply.status(401).send({ error: 'Invalid or expired nonce' });
    }

    // ── 3. Verificar firma con viem ─────────────────
    try {
      const valid = await verifyMessage({
        address:   address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
      if (!valid) {
        logger.warn({ address: normalizedAddress }, 'Invalid SIWE signature');
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    } catch (err) {
      logger.error({ err, address: normalizedAddress }, 'Signature verification error');
      return reply.status(401).send({ error: 'Signature verification failed' });
    }

    // ── 4. Upsert usuario en DB ─────────────────────
    const [user] = await db<{ id: string; kyc_status: string; transaction_tier: string }[]>`
      INSERT INTO users (wallet_address)
      VALUES (${normalizedAddress})
      ON CONFLICT (wallet_address) DO UPDATE
        SET updated_at = NOW()
      RETURNING id, kyc_status, transaction_tier
    `;

    logger.info({ userId: user.id, address: normalizedAddress }, 'User authenticated');

    // ── 5. Emitir JWT ───────────────────────────────
    const token = server.jwt.sign({
      sub:    user.id.toString(),
      wallet: normalizedAddress,
      kyc:    user.kyc_status,
    });

    return reply.send({
      token,
      user: {
        id:              user.id,
        walletAddress:   normalizedAddress,
        kycStatus:       user.kyc_status,
        transactionTier: user.transaction_tier,
      },
    });
  });

  // ── GET /v1/auth/me ────────────────────────────
  // Devuelve el perfil del usuario autenticado.
  server.get(
    '/me',
    { preHandler: [server.authenticate] },
    async (request, reply) => {
      const { sub } = request.user;
      const [user] = await db<{
        id:               string;
        wallet_address:   string;
        kyc_status:       string;
        transaction_tier: string;
        full_name:        string | null;
        kyc_approved_at:  string | null;
        created_at:       string;
      }[]>`
        SELECT id, wallet_address, kyc_status, transaction_tier,
               full_name, kyc_approved_at, created_at
        FROM users
        WHERE id = ${sub}
      `;

      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send({ data: user });
    },
  );
}
