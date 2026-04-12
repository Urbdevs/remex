import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from './auth';
import authPlugin from '../plugins/auth';

// ── MOCKS ─────────────────────────────────────────────

vi.mock('../db/client', () => ({
  getDB: vi.fn(),
  connectDB: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  storeNonce:   vi.fn(),
  consumeNonce: vi.fn(),
}));

vi.mock('viem', () => ({
  verifyMessage: vi.fn(),
}));

const mockUser = { id: '1', kyc_status: 'none', transaction_tier: 'unverified' };

// ── HELPERS ───────────────────────────────────────────

async function buildServer() {
  process.env.JWT_SECRET = 'test-secret-for-unit-tests-at-least-32-chars';

  const app = Fastify({ logger: false });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody: string }).rawBody = body as string;
    try { done(null, JSON.parse(body as string)); }
    catch (err) { done(err as Error, undefined); }
  });

  await app.register(authPlugin);
  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.ready();
  return app;
}

// ── TESTS ─────────────────────────────────────────────

describe('GET /v1/auth/nonce', () => {
  it('returns nonce and SIWE message for valid address', async () => {
    const { storeNonce } = await import('../services/redis');
    vi.mocked(storeNonce).mockResolvedValue(undefined);

    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url:    '/v1/auth/nonce?address=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(body.message).toContain('remex.mx');
    expect(body.message).toContain('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(body.message).toContain(body.nonce);
  });

  it('rejects invalid Ethereum address', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url:    '/v1/auth/nonce?address=notanaddress',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing address', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/auth/nonce' });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/auth/verify', () => {
  const validAddress   = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const validNonce     = 'aabbccdd11223344aabbccdd11223344';
  // issuedAt debe ser reciente (≤5 min); se genera en cada test
  function makeValidMessage() {
    return `remex.mx wants you to sign in with your Ethereum account:\n${validAddress}\n\nSign in to Remex — USA→México remittances\n\nURI: http://localhost:3000\nVersion: 1\nChain ID: 84532\nNonce: ${validNonce}\nIssued At: ${new Date().toISOString()}`;
  }
  const validSignature = '0xdeadbeef';

  beforeEach(() => {
    vi.resetModules();
  });

  it('issues JWT on valid signature and nonce', async () => {
    const redisMod = await import('../services/redis');
    const viemMod  = await import('viem');
    const dbMod    = await import('../db/client');

    vi.mocked(redisMod.consumeNonce).mockResolvedValue(true);
    vi.mocked(viemMod.verifyMessage).mockResolvedValue(true);

    const mockSql = vi.fn().mockResolvedValue([mockUser]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/auth/verify',
      payload: { address: validAddress, signature: validSignature, message: makeValidMessage() },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
    expect(body.user.walletAddress).toBe(validAddress.toLowerCase());
    expect(body.user.kycStatus).toBe('none');
  });

  it('rejects expired/invalid nonce', async () => {
    const redisMod = await import('../services/redis');
    vi.mocked(redisMod.consumeNonce).mockResolvedValue(false);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/auth/verify',
      payload: { address: validAddress, signature: validSignature, message: makeValidMessage() },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid or expired nonce');
  });

  it('rejects invalid signature', async () => {
    const redisMod = await import('../services/redis');
    const viemMod  = await import('viem');

    vi.mocked(redisMod.consumeNonce).mockResolvedValue(true);
    vi.mocked(viemMod.verifyMessage).mockResolvedValue(false);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/auth/verify',
      payload: { address: validAddress, signature: validSignature, message: makeValidMessage() },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid signature');
  });

  it('rejects message with no nonce field', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/auth/verify',
      payload: {
        address:   validAddress,
        signature: validSignature,
        message:   'message without nonce',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects message with expired Issued At (>5 min old)', async () => {
    const staleMessage = `remex.mx wants you to sign in with your Ethereum account:\n${validAddress}\n\nSign in to Remex — USA→México remittances\n\nURI: http://localhost:3000\nVersion: 1\nChain ID: 84532\nNonce: ${validNonce}\nIssued At: 2024-01-01T00:00:00.000Z`;

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/auth/verify',
      payload: { address: validAddress, signature: validSignature, message: staleMessage },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/expired/i);
  });

  it('rejects message with nonce length ≠ 32 hex chars', async () => {
    // 31-char nonce (one char short) should fail regex
    const shortNonceMsg = `remex.mx wants you to sign in with your Ethereum account:\n${validAddress}\n\nSign in to Remex — USA→México remittances\n\nURI: http://localhost:3000\nVersion: 1\nChain ID: 84532\nNonce: aabbccdd11223344aabbccdd1122334\nIssued At: ${new Date().toISOString()}`;

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/auth/verify',
      payload: { address: validAddress, signature: validSignature, message: shortNonceMsg },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid SIWE message format');
  });
});

describe('GET /v1/auth/me', () => {
  it('returns 401 without token', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns user profile with valid JWT', async () => {
    const dbMod = await import('../db/client');
    const dbRow = {
      id:               '1',
      wallet_address:   '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      kyc_status:       'none',
      transaction_tier: 'unverified',
      full_name:        null,
      kyc_approved_at:  null,
      created_at:       new Date().toISOString(),
    };
    const mockSql = vi.fn().mockResolvedValue([dbRow]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();

    // Generar token directamente
    const token = app.jwt.sign({
      sub:    '1',
      wallet: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      kyc:    'none',
    });

    const res = await app.inject({
      method:  'GET',
      url:     '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.wallet_address).toBeDefined();
  });
});
