import Redis from 'ioredis';
import { logger } from './logger';

let redisClient: Redis;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host:     process.env.REDIS_HOST     ?? 'localhost',
      port:     Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD,
      lazyConnect: true,
    });

    redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis connection error');
    });
  }
  return redisClient;
}

// ── NONCES para SIWE (TTL 5 minutos) ─────────────────
const NONCE_TTL_SECONDS = 300;

export async function storeNonce(address: string, nonce: string): Promise<void> {
  const redis = getRedis();
  await redis.set(`nonce:${address.toLowerCase()}`, nonce, 'EX', NONCE_TTL_SECONDS);
}

export async function consumeNonce(address: string, nonce: string): Promise<boolean> {
  const redis = getRedis();
  const key = `nonce:${address.toLowerCase()}`;
  // GETDEL es atómico: obtiene y elimina en un solo comando (protección TOCTOU)
  const stored = await redis.getdel(key);
  return stored === nonce;
}
