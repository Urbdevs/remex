import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { transferRoutes } from './transfers';
import authPlugin from '../plugins/auth';

// ── MOCKS ─────────────────────────────────────────────

vi.mock('../db/client', () => ({ getDB: vi.fn(), connectDB: vi.fn() }));
vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/crypto', () => ({
  encrypt: vi.fn().mockReturnValue('iv:tag:ciphertext'),
  decrypt: vi.fn(),
}));

// ── FIXTURES ──────────────────────────────────────────

const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const OTHER_WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const REM_ID = 'rem-00000000-0000-0000-0000-000000000001';

const mockRemittance = {
  remittance_id: REM_ID,
  user_id: '1',
  sender: WALLET,
  amount_usdc: '100000000',
  fee_usdc: '1000000',
  status: 'delivered',
  fx_rate: '17.82',
  mxn_amount: '1782.00',
  spei_reference: 'SPEI-001',
  error_message: null,
  tx_hash: '0xabc123',
  block_number: '1000',
  created_at: new Date().toISOString(),
  resolved_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ── SERVER BUILDER ────────────────────────────────────

async function buildServer(): Promise<FastifyInstance> {
  process.env.JWT_SECRET = 'test-secret-for-unit-tests-at-least-32-chars';

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body as string)); }
    catch (err) { done(err as Error, undefined); }
  });
  await app.register(authPlugin);
  await app.register(transferRoutes, { prefix: '/v1/transfers' });
  await app.ready();
  return app;
}

function bearerToken(app: FastifyInstance, kyc = 'none') {
  return `Bearer ${app.jwt.sign({ sub: '1', wallet: WALLET, kyc })}`;
}

function kycBearer(app: FastifyInstance) {
  return bearerToken(app, 'approved');
}

// ─────────────────────────────────────────────────────
// GET /v1/transfers/:id
// ─────────────────────────────────────────────────────

describe('GET /v1/transfers/:id', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns 401 without JWT', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/v1/transfers/${REM_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for non-existent remittance', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     `/v1/transfers/${REM_ID}`,
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Remittance not found');
  });

  it('returns 404 when accessing another user remittance (wallet mismatch)', async () => {
    // DB returns empty because JOIN on wallet_address filters it out
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    // JWT wallet = WALLET, but remittance belongs to OTHER_WALLET (filtered by DB join)
    const res = await app.inject({
      method:  'GET',
      url:     `/v1/transfers/${REM_ID}`,
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns remittance data for the authenticated owner', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([mockRemittance]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     `/v1/transfers/${REM_ID}`,
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.remittance_id).toBe(REM_ID);
    expect(res.json().data.status).toBe('delivered');
  });
});

// ─────────────────────────────────────────────────────
// GET /v1/transfers
// ─────────────────────────────────────────────────────

describe('GET /v1/transfers', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns 401 without JWT', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/transfers' });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty array for user with no remittances', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/transfers',
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it('returns remittances list with pagination fields', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(
      vi.fn().mockResolvedValue([mockRemittance, mockRemittance]) as never
    );

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/transfers?limit=10&offset=0',
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
  });

  it('returns 400 for invalid status filter', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/transfers?status=invalid_status',
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts valid status filter', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([mockRemittance]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/transfers?status=delivered',
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────
// GET /v1/transfers/:id/status
// ─────────────────────────────────────────────────────

describe('GET /v1/transfers/:id/status', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns 401 without JWT', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/v1/transfers/${REM_ID}/status` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when remittance not found', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     `/v1/transfers/${REM_ID}/status`,
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns status fields for authenticated owner', async () => {
    const statusRow = {
      remittance_id:  REM_ID,
      status:         'delivered',
      spei_reference: 'SPEI-001',
      mxn_amount:     '1782.00',
      fx_rate:        '17.82',
      resolved_at:    new Date().toISOString(),
    };
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([statusRow]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     `/v1/transfers/${REM_ID}/status`,
      headers: { authorization: bearerToken(app) },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.status).toBe('delivered');
    expect(data.spei_reference).toBe('SPEI-001');
    expect(data.mxn_amount).toBe('1782.00');
  });
});

// ─────────────────────────────────────────────────────
// POST /v1/transfers/recipient-info
// ─────────────────────────────────────────────────────

describe('POST /v1/transfers/recipient-info', () => {
  beforeEach(() => { vi.resetModules(); });

  const validPayload = {
    clabeHash:      '0x' + 'a'.repeat(64),
    recipientPhone: '+15551234567',
  };

  it('returns 401 without JWT', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/recipient-info',
      payload: validPayload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when KYC not approved', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/recipient-info',
      headers: { authorization: bearerToken(app, 'none') },
      payload: validPayload,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('KYC_REQUIRED');
  });

  it('returns 400 for missing clabeHash', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/recipient-info',
      headers: { authorization: kycBearer(app) },
      payload: { recipientPhone: '+15551234567' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid clabeHash (not bytes32 hex)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/recipient-info',
      headers: { authorization: kycBearer(app) },
      payload: { clabeHash: 'not-a-hash', recipientPhone: '+15551234567' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid recipientPhone (not E.164)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/recipient-info',
      headers: { authorization: kycBearer(app) },
      payload: { clabeHash: '0x' + 'a'.repeat(64), recipientPhone: '5551234567' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stores encrypted phone and returns 201 for valid payload', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/recipient-info',
      headers: { authorization: kycBearer(app) },
      payload: validPayload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().registered).toBe(true);
  });

  it('returns 201 on duplicate (upsert behavior)', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    // First call
    await app.inject({
      method:  'POST',
      url:     '/v1/transfers/recipient-info',
      headers: { authorization: kycBearer(app) },
      payload: validPayload,
    });
    // Second call with same data (upsert)
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/recipient-info',
      headers: { authorization: kycBearer(app) },
      payload: validPayload,
    });
    expect(res.statusCode).toBe(201);
  });
});

// ─────────────────────────────────────────────────────
// POST /v1/transfers/check-limit
// ─────────────────────────────────────────────────────

describe('POST /v1/transfers/check-limit', () => {
  beforeEach(() => { vi.resetModules(); });

  const today = new Date().toISOString().slice(0, 10);

  it('returns 401 without JWT', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      payload: { amountUsd: 100 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when KYC not approved', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: bearerToken(app, 'none') },
      payload: { amountUsd: 100 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for missing amountUsd', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: kycBearer(app) },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for amountUsd ≤ 0', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: kycBearer(app) },
      payload: { amountUsd: -50 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('unverified user: allows amount within $500 daily limit', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{
      transaction_tier: 'unverified',
      daily_sent_usd:   '0',
      daily_reset_at:   today,
    }]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: kycBearer(app) },
      payload: { amountUsd: 400 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.allowed).toBe(true);
    expect(body.tier).toBe('unverified');
    expect(body.dailyLimit).toBe(500);
    expect(body.remaining).toBe(500);
  });

  it('unverified user: blocks amount exceeding $500 daily limit', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{
      transaction_tier: 'unverified',
      daily_sent_usd:   '0',
      daily_reset_at:   today,
    }]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: kycBearer(app) },
      payload: { amountUsd: 501 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowed).toBe(false);
    expect(res.json().remaining).toBe(500);
  });

  it('standard user: allows up to $3,000 daily', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{
      transaction_tier: 'standard',
      daily_sent_usd:   '0',
      daily_reset_at:   today,
    }]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: kycBearer(app) },
      payload: { amountUsd: 2500 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.allowed).toBe(true);
    expect(body.dailyLimit).toBe(3000);
  });

  it('enhanced user: allows up to $10,000 daily', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{
      transaction_tier: 'enhanced',
      daily_sent_usd:   '0',
      daily_reset_at:   today,
    }]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: kycBearer(app) },
      payload: { amountUsd: 9000 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.allowed).toBe(true);
    expect(body.dailyLimit).toBe(10000);
  });

  it('blocks when cumulative daily usage exceeds limit', async () => {
    const dbMod = await import('../db/client');
    // User already sent $450 today
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{
      transaction_tier: 'unverified',
      daily_sent_usd:   '450',
      daily_reset_at:   today,
    }]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: kycBearer(app) },
      payload: { amountUsd: 100 }, // 450 + 100 = 550 > 500
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.allowed).toBe(false);
    expect(body.dailySentUsd).toBe(450);
    expect(body.remaining).toBe(50);
  });

  it('resets daily counter when daily_reset_at is not today', async () => {
    const dbMod = await import('../db/client');
    // daily_reset_at is yesterday — counter should reset to 0
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{
      transaction_tier: 'unverified',
      daily_sent_usd:   '499',
      daily_reset_at:   '2020-01-01', // stale date
    }]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/transfers/check-limit',
      headers: { authorization: kycBearer(app) },
      payload: { amountUsd: 400 }, // reset → 0 + 400 < 500 → allowed
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowed).toBe(true);
    expect(res.json().dailySentUsd).toBe(0);
  });
});
