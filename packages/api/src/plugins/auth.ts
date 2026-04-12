import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import crypto from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ── TIPOS ─────────────────────────────────────────────

export interface JWTPayload {
  sub:    string;   // user.id (bigint as string)
  wallet: string;   // wallet_address lowercase
  kyc:    string;   // kyc_status
}

// Extender FastifyRequest para tener `user` tipado
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JWTPayload;
    user:    JWTPayload;
  }
}

// ── KYC TIERS Y LÍMITES (FinCEN MSB) ─────────────────

export const KYC_TIER_LIMITS: Record<string, number> = {
  unverified: 500,    // $500/día sin KYC
  standard:   3_000,  // $3,000/día — KYC básico aprobado
  enhanced:   10_000, // $10,000/día — KYC enhanced
};

// ── PLUGIN ────────────────────────────────────────────

async function authPlugin(server: FastifyInstance) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters long');
  }

  await server.register(jwt, {
    secret: jwtSecret,
    sign:   { expiresIn: '8h', algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });

  // ── DECORATOR: authenticate ────────────────────────
  // Verifica que el request tiene un JWT válido.
  server.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
      }
    },
  );

  // ── DECORATOR: requireKYC ──────────────────────────
  // Verifica JWT válido + KYC aprobado.
  // Cumplimiento FinCEN: ninguna transferencia sin identidad verificada.
  server.decorate(
    'requireKYC',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
      }

      if (request.user.kyc !== 'approved') {
        return reply.status(403).send({
          error:   'KYC_REQUIRED',
          message: 'Identity verification required to send remittances',
          kycStatus: request.user.kyc,
        });
      }
    },
  );

  // ── DECORATOR: requireAdmin ────────────────────────
  // Protege el dashboard de administración.
  // Header requerido: X-Admin-Key: <ADMIN_API_KEY>
  // Usa comparación en tiempo constante para evitar timing attacks.
  server.decorate(
    'requireAdmin',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminKey = process.env.ADMIN_API_KEY ?? '';

      if (adminKey.length < 32) {
        // Fail-secure: si no está configurado, denegar acceso
        return reply.status(503).send({
          error: 'Admin access not configured',
          message: 'ADMIN_API_KEY must be set (min 32 chars)',
        });
      }

      const provided = (request.headers['x-admin-key'] as string) ?? '';

      if (!provided) {
        return reply.status(401).send({ error: 'Missing X-Admin-Key header' });
      }

      // timingSafeEqual requiere buffers de igual longitud
      const providedBuf = Buffer.from(provided);
      const expectedBuf = Buffer.from(adminKey);

      const lengthMatch = providedBuf.length === expectedBuf.length;
      // Siempre comparar aunque la longitud no coincida (evita timing leak)
      const contentMatch = crypto.timingSafeEqual(
        Buffer.from(provided.padEnd(adminKey.length, '\0')),
        Buffer.from(adminKey),
      );

      if (!lengthMatch || !contentMatch) {
        return reply.status(401).send({ error: 'Invalid admin key' });
      }
    },
  );
}

export default fp(authPlugin, { name: 'auth' });

// ── TIPOS PARA FASTIFY (augmentation) ─────────────────

declare module 'fastify' {
  interface FastifyInstance {
    authenticate:  (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireKYC:    (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin:  (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
