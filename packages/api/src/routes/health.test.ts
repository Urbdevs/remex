import { describe, it, expect, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';

// ── MOCKS ─────────────────────────────────────────────

vi.mock('../db/client', () => ({ getDB: vi.fn(), connectDB: vi.fn() }));
vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── SERVER BUILDER ────────────────────────────────────

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(healthRoutes, { prefix: '/health' });
  await app.ready();
  return app;
}

// ─────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok when DB is reachable', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{ '?column?': 1 }]) as never);

    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.services.database).toBe('ok');
    expect(body.services.server).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('returns 503 when DB is unavailable', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never);

    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.message).toBe('Database unavailable');
  });

  it('requires no authentication', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    // No Authorization header — must still return 200
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('returns JSON content-type', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
