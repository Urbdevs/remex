/**
 * OWASP Top 10 (2021) — Automated Security Checks
 *
 * Estos tests verifican los controles de seguridad más importantes
 * a través de los endpoints reales de la API (Fastify inject).
 *
 * No reemplazan la revisión manual, pero detectan regresiones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { adminRoutes } from '../../routes/admin';
import { authRoutes } from '../../routes/auth';
import { transferRoutes } from '../../routes/transfers';
import authPlugin from '../../plugins/auth';

// ── MOCKS ─────────────────────────────────────────────

vi.mock('../../db/client', () => ({ getDB: vi.fn(), connectDB: vi.fn() }));
vi.mock('../../jobs/remittanceQueue', () => ({
  remittanceQueue: {
    name:         'remittances',
    getJobCounts: vi.fn(),
    isPaused:     vi.fn(),
  },
}));
vi.mock('../../services/redis', () => ({
  storeNonce:   vi.fn(),
  consumeNonce: vi.fn(),
}));
vi.mock('viem', () => ({ verifyMessage: vi.fn() }));
vi.mock('../../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/crypto', () => ({
  encrypt: vi.fn().mockReturnValue('iv:tag:ciphertext'),
  decrypt: vi.fn(),
}));

// ── CONSTANTS ─────────────────────────────────────────

const ADMIN_KEY = 'test-admin-key-at-least-32-chars-long!!';
const JWT_SECRET = 'test-secret-for-unit-tests-at-least-32-chars';
const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const REM_ID = 'rem-00000000-0000-0000-0000-000000000001';

// ── SERVER BUILDERS ───────────────────────────────────

async function buildAdminServer(): Promise<FastifyInstance> {
  process.env.JWT_SECRET    = JWT_SECRET;
  process.env.ADMIN_API_KEY = ADMIN_KEY;

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body as string)); }
    catch (err) { done(err as Error, undefined); }
  });
  await app.register(authPlugin);
  await app.register(adminRoutes, { prefix: '/v1/admin' });
  await app.ready();
  return app;
}

async function buildAuthServer(): Promise<FastifyInstance> {
  process.env.JWT_SECRET    = JWT_SECRET;
  process.env.ADMIN_API_KEY = ADMIN_KEY;

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body as string)); }
    catch (err) { done(err as Error, undefined); }
  });
  await app.register(authPlugin);
  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.ready();
  return app;
}

async function buildFullServer(): Promise<FastifyInstance> {
  process.env.JWT_SECRET    = JWT_SECRET;
  process.env.ADMIN_API_KEY = ADMIN_KEY;

  const app = Fastify({ logger: false });
  await app.register(helmet);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body as string)); }
    catch (err) { done(err as Error, undefined); }
  });
  await app.register(authPlugin);
  await app.register(transferRoutes, { prefix: '/v1/transfers' });
  await app.register(adminRoutes, { prefix: '/v1/admin' });
  await app.ready();
  return app;
}

// ─────────────────────────────────────────────────────
// A01 — Broken Access Control
// ─────────────────────────────────────────────────────

describe('A01 — Broken Access Control', () => {
  beforeEach(() => { vi.resetModules(); });

  it('admin endpoints return 401 without X-Admin-Key', async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('admin endpoints return 401 with wrong X-Admin-Key', async () => {
    const app = await buildAdminServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics',
      headers: { 'x-admin-key': 'wrong-key-that-does-not-match' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('transfer endpoints return 404 when accessing another users remittance', async () => {
    // The DB JOIN on wallet_address returns empty — enforces ownership
    const dbMod = await import('../../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildFullServer();
    const token = `Bearer ${app.jwt.sign({ sub: '1', wallet: WALLET, kyc: 'none' })}`;

    const res = await app.inject({
      method:  'GET',
      url:     `/v1/transfers/${REM_ID}`,
      headers: { authorization: token },
    });
    // 404 (not 200 with other user data, not 403 that leaks existence)
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────
// A02 — Cryptographic Failures
// ─────────────────────────────────────────────────────

describe('A02 — Cryptographic Failures', () => {
  it('throws on server startup when JWT_SECRET < 32 chars', async () => {
    const shortSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'short';

    const app = Fastify({ logger: false });
    await expect(app.register(authPlugin)).rejects.toThrow(
      'JWT_SECRET must be set and at least 32 characters long',
    );

    process.env.JWT_SECRET = shortSecret;
  });

  it('returns 503 when ADMIN_API_KEY < 32 chars (fail-secure)', async () => {
    const app = await buildAdminServer();
    process.env.ADMIN_API_KEY = 'short'; // override after build

    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics',
      headers: { 'x-admin-key': 'short' },
    });
    process.env.ADMIN_API_KEY = ADMIN_KEY; // restore

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Admin access not configured');
  });
});

// ─────────────────────────────────────────────────────
// A03 — Injection
// ─────────────────────────────────────────────────────

describe('A03 — Injection', () => {
  beforeEach(() => { vi.resetModules(); });

  it('admin remittances: SQL injection in status param is blocked by Zod enum', async () => {
    const app = await buildAdminServer();
    const res = await app.inject({
      method:  'GET',
      url:     `/v1/admin/remittances?status=' OR '1'='1`,
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    // Zod enum validation rejects non-enum values → 400
    expect(res.statusCode).toBe(400);
  });

  it('admin remittances: SQL injection attempt in dateFrom is blocked by regex', async () => {
    const app = await buildAdminServer();
    const res = await app.inject({
      method:  'GET',
      url:     `/v1/admin/remittances?dateFrom=2024-01-01; DROP TABLE remittances--`,
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(400);
  });

  it('transfers: invalid status enum is rejected at Zod layer', async () => {
    const app = await buildFullServer();
    const token = `Bearer ${app.jwt.sign({ sub: '1', wallet: WALLET, kyc: 'none' })}`;

    const res = await app.inject({
      method:  'GET',
      url:     '/v1/transfers?status=<script>alert(1)</script>',
      headers: { authorization: token },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────
// A04 — Insecure Design
// ─────────────────────────────────────────────────────

describe('A04 — Insecure Design (SIWE)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('rejects SIWE message with nonce ≠ 32 hex chars (short)', async () => {
    const addr = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    // 31-char nonce — one char short
    const shortNonce = 'aabbccdd11223344aabbccdd1122334';
    const msg = `remex.mx wants you to sign in with your Ethereum account:\n${addr}\n\nSign in to Remex — USA→México remittances\n\nURI: http://localhost:3000\nVersion: 1\nChain ID: 84532\nNonce: ${shortNonce}\nIssued At: ${new Date().toISOString()}`;

    const app = await buildAuthServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/auth/verify',
      payload: { address: addr, signature: '0xdeadbeef', message: msg },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid SIWE message format');
  });

  it('rejects SIWE message with expired Issued At (> 5 minutes old)', async () => {
    const addr = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const nonce = 'aabbccdd11223344aabbccdd11223344';
    const staleMsg = `remex.mx wants you to sign in with your Ethereum account:\n${addr}\n\nSign in to Remex — USA→México remittances\n\nURI: http://localhost:3000\nVersion: 1\nChain ID: 84532\nNonce: ${nonce}\nIssued At: 2024-01-01T00:00:00.000Z`;

    const app = await buildAuthServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/auth/verify',
      payload: { address: addr, signature: '0xdeadbeef', message: staleMsg },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/expired/i);
  });
});

// ─────────────────────────────────────────────────────
// A05 — Security Misconfiguration
// ─────────────────────────────────────────────────────

describe('A05 — Security Misconfiguration', () => {
  it('Helmet sets X-Content-Type-Options: nosniff header', async () => {
    const dbMod = await import('../../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildFullServer();
    const token = `Bearer ${app.jwt.sign({ sub: '1', wallet: WALLET, kyc: 'none' })}`;
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/transfers',
      headers: { authorization: token },
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('Helmet sets X-Frame-Options header', async () => {
    const dbMod = await import('../../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildFullServer();
    const token = `Bearer ${app.jwt.sign({ sub: '1', wallet: WALLET, kyc: 'none' })}`;
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/transfers',
      headers: { authorization: token },
    });
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────
// A07 — Identification and Authentication Failures
// ─────────────────────────────────────────────────────

describe('A07 — Identification and Authentication Failures', () => {
  it('returns 401 for missing Authorization header', async () => {
    const app = await buildFullServer();
    const res = await app.inject({ method: 'GET', url: `/v1/transfers/${REM_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for JWT signed with wrong secret', async () => {
    const app = await buildFullServer();
    // Sign with a different secret
    const fakeApp = Fastify({ logger: false });
    await fakeApp.register(authPlugin);
    // Can't easily sign with wrong secret — instead craft a tampered token
    const validToken = app.jwt.sign({ sub: '1', wallet: WALLET, kyc: 'none' });
    const tampered   = validToken.slice(0, -5) + 'XXXXX'; // corrupt signature

    const res = await app.inject({
      method:  'GET',
      url:     `/v1/transfers/${REM_ID}`,
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for expired JWT', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const app = await buildFullServer();
    // Sign token that expires in 1 second
    const token = app.jwt.sign(
      { sub: '1', wallet: WALLET, kyc: 'none' },
      { expiresIn: '1s' },
    );

    // Advance time past expiry
    vi.setSystemTime(now + 2000);

    const res = await app.inject({
      method:  'GET',
      url:     `/v1/transfers/${REM_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    vi.useRealTimers();
    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────
// A09 — Security Logging and Monitoring Failures
// ─────────────────────────────────────────────────────

describe('A09 — Security Logging and Monitoring', () => {
  it('logs a warning when stuck remittances are detected', async () => {
    const dbMod = await import('../../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{
      remittance_id: 'rem-stuck-1',
      sender:        WALLET,
      amount_usdc:   '50.000000',
      mxn_amount:    '891.00',
      minutes_stuck: '25.0',
      updated_at:    new Date(Date.now() - 25 * 60 * 1000).toISOString(),
      tx_hash:       '0xabc',
    }]) as never);

    const loggerMod = await import('../../services/logger');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');

    const app = await buildAdminServer();
    await app.inject({
      method:  'GET',
      url:     '/v1/admin/stuck',
      headers: { 'x-admin-key': ADMIN_KEY },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, thresholdMinutes: 15 }),
      'Admin alert: stuck remittances detected',
    );
  });
});
