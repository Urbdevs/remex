import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { kycRoutes } from './kyc';
import authPlugin from '../plugins/auth';
import crypto from 'crypto';

// ── MOCKS ─────────────────────────────────────────────

vi.mock('../db/client', () => ({
  getDB:     vi.fn(),
  connectDB: vi.fn(),
}));

vi.mock('../services/persona', () => ({
  personaService: {
    createInquiry:            vi.fn(),
    getInquiry:               vi.fn(),
    verifyWebhookSignature:   vi.fn(),
    mapStatus:                vi.fn(),
    extractNameFromWebhook:   vi.fn(),
  },
}));

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
  await app.register(kycRoutes, { prefix: '/v1/kyc' });
  await app.ready();
  return app;
}

function makeToken(app: ReturnType<typeof Fastify>, kyc = 'none') {
  return (app as typeof app & { jwt: { sign: (p: object) => string } }).jwt.sign({
    sub:    '1',
    wallet: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    kyc,
  });
}

// ── TESTS ─────────────────────────────────────────────

describe('POST /v1/kyc/start', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 without token', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/v1/kyc/start' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 if KYC already approved', async () => {
    const app   = await buildServer();
    const token = makeToken(app as never, 'approved');

    const res = await app.inject({
      method:  'POST',
      url:     '/v1/kyc/start',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('KYC_ALREADY_APPROVED');
  });

  it('creates inquiry and returns session token', async () => {
    const dbMod      = await import('../db/client');
    const personaMod = await import('../services/persona');

    const mockSql = vi.fn()
      .mockResolvedValueOnce([{ persona_inquiry_id: null, kyc_status: 'none' }]) // SELECT
      .mockResolvedValueOnce([])  // UPDATE users
      .mockResolvedValueOnce([]); // INSERT kyc_events
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    vi.mocked(personaMod.personaService.createInquiry).mockResolvedValue({
      inquiryId:    'inq_test_123',
      sessionToken: 'session_test_abc',
      status:       'pending',
    });

    const app   = await buildServer();
    const token = makeToken(app as never);

    const res = await app.inject({
      method:  'POST',
      url:     '/v1/kyc/start',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.inquiryId).toBe('inq_test_123');
    expect(body.sessionToken).toBe('session_test_abc');
  });

  it('returns 400 if inquiry already submitted', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValueOnce([{
      persona_inquiry_id: 'inq_existing',
      kyc_status:         'submitted',
    }]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app   = await buildServer();
    const token = makeToken(app as never, 'submitted');

    const res = await app.inject({
      method:  'POST',
      url:     '/v1/kyc/start',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('KYC_UNDER_REVIEW');
  });
});

describe('GET /v1/kyc/status', () => {
  it('returns 401 without token', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/kyc/status' });
    expect(res.statusCode).toBe(401);
  });

  it('returns KYC status for authenticated user', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValueOnce([{
      kyc_status:         'pending',
      transaction_tier:   'unverified',
      persona_inquiry_id: 'inq_123',
      kyc_approved_at:    null,
    }]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app   = await buildServer();
    const token = makeToken(app as never);

    const res = await app.inject({
      method:  'GET',
      url:     '/v1/kyc/status',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.kyc_status).toBe('pending');
  });
});

describe('POST /v1/kyc/webhook', () => {
  function buildWebhookHeader(rawBody: string, secret: string): string {
    const ts  = Date.now().toString();
    const sig = crypto
      .createHmac('sha256', secret)
      .update(`${ts}.${rawBody}`)
      .digest('hex');
    return `t=${ts},v1=${sig}`;
  }

  it('returns 400 when signature header is missing', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/kyc/webhook',
      payload: { data: { type: 'inquiry.approved', id: 'inq_123', attributes: { status: 'approved' } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Missing signature');
  });

  it('returns 401 when signature is invalid', async () => {
    const personaMod = await import('../services/persona');
    vi.mocked(personaMod.personaService.verifyWebhookSignature).mockReturnValue(false);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/kyc/webhook',
      headers: { 'persona-signature': 't=123,v1=badsig' },
      payload: { data: { type: 'inquiry.approved', id: 'inq_123', attributes: { status: 'approved' } } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('processes approved webhook and updates user tier', async () => {
    const personaMod = await import('../services/persona');
    const dbMod      = await import('../db/client');

    vi.mocked(personaMod.personaService.verifyWebhookSignature).mockReturnValue(true);
    vi.mocked(personaMod.personaService.mapStatus).mockReturnValue('approved');
    vi.mocked(personaMod.personaService.extractNameFromWebhook).mockReturnValue('John Doe');

    const mockSql = vi.fn()
      .mockResolvedValueOnce([{ id: '1', kyc_status: 'submitted' }]) // find user
      .mockResolvedValueOnce([]) // insert webhook_received event
      .mockResolvedValueOnce([]) // update user
      .mockResolvedValueOnce([]); // insert approved event
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const payload = JSON.stringify({
      data: {
        type: 'inquiry.approved',
        id:   'inq_123',
        attributes: { status: 'approved', name: 'John Doe' },
        relationships: { inquiry: { data: { id: 'inq_123' } } },
      },
    });

    const res = await app.inject({
      method:  'POST',
      url:     '/v1/kyc/webhook',
      headers: {
        'content-type':      'application/json',
        'persona-signature': 't=123,v1=sig',
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('returns 200 when no user found for inquiry (graceful)', async () => {
    const personaMod = await import('../services/persona');
    const dbMod      = await import('../db/client');

    vi.mocked(personaMod.personaService.verifyWebhookSignature).mockReturnValue(true);
    const mockSql = vi.fn().mockResolvedValueOnce([]); // No user found
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'POST',
      url:     '/v1/kyc/webhook',
      headers: {
        'content-type':      'application/json',
        'persona-signature': 't=123,v1=sig',
      },
      payload: {
        data: {
          type: 'inquiry.approved',
          id:   'inq_unknown',
          attributes: { status: 'approved' },
          relationships: { inquiry: { data: { id: 'inq_unknown' } } },
        },
      },
    });

    expect(res.statusCode).toBe(200);
  });
});
