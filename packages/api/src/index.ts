import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from 'dotenv';
import { logger } from './services/logger';
import { transferRoutes } from './routes/transfers';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { kycRoutes } from './routes/kyc';
import { adminRoutes } from './routes/admin';
import authPlugin from './plugins/auth';
import { startBridgeListener } from './listeners/bridgeListener';
import { connectDB } from './db/client';

// Extiende FastifyContextConfig para permitir rawBody: true en rutas que
// necesitan el body crudo (p. ej. verificación de firma en webhooks).
declare module 'fastify' {
  interface FastifyContextConfig {
    rawBody?: boolean;
  }
}

config();

const server = Fastify({ logger: false });

async function bootstrap() {
  // ── PLUGINS ──────────────────────────────────────
  await server.register(cors, {
    origin:      process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });
  await server.register(helmet);
  await server.register(rateLimit, {
    global:     true,
    max:        100,
    timeWindow: '1 minute',
  });

  // Preservar raw body para webhook signature verification
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as typeof req & { rawBody: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Plugin JWT + decoradores authenticate / requireKYC
  await server.register(authPlugin);

  // ── ROUTES ───────────────────────────────────────
  await server.register(healthRoutes,   { prefix: '/health' });
  await server.register(authRoutes,     { prefix: '/v1/auth' });
  await server.register(kycRoutes,      { prefix: '/v1/kyc' });
  await server.register(transferRoutes, { prefix: '/v1/transfers' });
  await server.register(adminRoutes,    { prefix: '/v1/admin' });

  // ── DATABASE ─────────────────────────────────────
  await connectDB();
  logger.info('Database connected');

  // ── BLOCKCHAIN LISTENER ──────────────────────────
  await startBridgeListener();
  logger.info('Bridge listener started');

  // ── START ────────────────────────────────────────
  const port = Number(process.env.PORT ?? 3001);
  await server.listen({ port, host: '0.0.0.0' });
  logger.info(`Server running on port ${port}`);
}

bootstrap().catch((err) => {
  logger.error(err);
  process.exit(1);
});
