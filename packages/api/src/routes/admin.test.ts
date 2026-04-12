import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { adminRoutes } from './admin';
import authPlugin from '../plugins/auth';

// ── MOCKS ─────────────────────────────────────────────

vi.mock('../db/client', () => ({ getDB: vi.fn(), connectDB: vi.fn() }));
vi.mock('../jobs/remittanceQueue', () => ({
  remittanceQueue: {
    name:         'remittances',
    getJobCounts: vi.fn(),
    isPaused:     vi.fn(),
  },
}));
vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ADMIN_KEY = 'test-admin-key-at-least-32-chars-long!!';

// ── SERVER BUILDER ────────────────────────────────────

async function buildServer(): Promise<FastifyInstance> {
  process.env.JWT_SECRET   = 'test-secret-for-unit-tests-at-least-32-chars';
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

function adminHeaders() {
  return { 'x-admin-key': ADMIN_KEY };
}

// ─────────────────────────────────────────────────────
// requireAdmin decorator
// ─────────────────────────────────────────────────────

describe('requireAdmin decorator', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns 401 when X-Admin-Key is missing', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/metrics' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Missing X-Admin-Key header');
  });

  it('returns 401 when X-Admin-Key is wrong', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([{
      total: '0', delivered: '0', refunded: '0', processing: '0', pending: '0',
      volume_usdc: '0', volume_mxn: '0', fees_usdc: '0',
      success_rate: null, avg_fx_rate: null,
    }]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics',
      headers: { 'x-admin-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid admin key');
  });

  it('returns 503 when ADMIN_API_KEY is not configured', async () => {
    // Build the server first (sets ADMIN_API_KEY = ADMIN_KEY internally),
    // then override to a short value so the decorator sees it at request time.
    const app = await buildServer();
    process.env.ADMIN_API_KEY = 'short'; // less than 32 chars — overrides after build
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics',
      headers: { 'x-admin-key': 'short' },
    });
    process.env.ADMIN_API_KEY = ADMIN_KEY; // restore
    expect(res.statusCode).toBe(503);
  });

  it('accepts correct X-Admin-Key', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValue([{
      total: '5', delivered: '3', refunded: '1', processing: '0', pending: '1',
      volume_usdc: '500.000000', volume_mxn: '8910.00', fees_usdc: '5.000000',
      success_rate: '75.00', avg_fx_rate: '17.8200',
    }]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────
// GET /v1/admin/metrics
// ─────────────────────────────────────────────────────

describe('GET /v1/admin/metrics', () => {
  it('returns correct daily metrics shape', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValue([{
      total: '10', delivered: '7', refunded: '2', processing: '1', pending: '0',
      volume_usdc: '1000.000000', volume_mxn: '17820.00', fees_usdc: '10.000000',
      success_rate: '77.78', avg_fx_rate: '17.8200',
    }]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics',
      headers: adminHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.total).toBe(10);
    expect(data.delivered).toBe(7);
    expect(data.refunded).toBe(2);
    expect(data.processing).toBe(1);
    expect(data.pending).toBe(0);
    expect(data.volumeUsdc).toBe(1000);
    expect(data.volumeMxn).toBe(17820);
    expect(data.feesUsdc).toBe(10);
    expect(data.successRatePct).toBe(77.78);
    expect(data.avgFxRate).toBe(17.82);
  });

  it('accepts ?date= param', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValue([{
      total: '0', delivered: '0', refunded: '0', processing: '0', pending: '0',
      volume_usdc: '0', volume_mxn: '0', fees_usdc: '0',
      success_rate: null, avg_fx_rate: null,
    }]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics?date=2025-01-15',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.date).toBe('2025-01-15');
  });

  it('returns 400 for invalid date format', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics?date=not-a-date',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns null successRatePct when no completed transactions', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValue([{
      total: '3', delivered: '0', refunded: '0', processing: '3', pending: '0',
      volume_usdc: '300', volume_mxn: '0', fees_usdc: '3',
      success_rate: null, avg_fx_rate: null,
    }]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.successRatePct).toBeNull();
  });
});

// ─────────────────────────────────────────────────────
// GET /v1/admin/metrics/history
// ─────────────────────────────────────────────────────

describe('GET /v1/admin/metrics/history', () => {
  it('returns hourly buckets array', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValue([
      { hour: '2025-01-15T10:00:00Z', total: '3', delivered: '2', volume_usdc: '300' },
      { hour: '2025-01-15T11:00:00Z', total: '5', delivered: '5', volume_usdc: '500' },
    ]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics/history',
      headers: adminHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data).toHaveLength(2);
    expect(data[0].hour).toBe('2025-01-15T10:00:00Z');
    expect(data[0].total).toBe(3);
    expect(data[0].delivered).toBe(2);
    expect(data[0].volumeUsdc).toBe(300);
  });

  it('returns empty array when no data in last 24h', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/metrics/history',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────
// GET /v1/admin/remittances
// ─────────────────────────────────────────────────────

describe('GET /v1/admin/remittances', () => {
  const mockRow = {
    remittance_id: 'rem-001', sender: '0xabc', amount_usdc: '100',
    fee_usdc: '1', status: 'delivered', fx_rate: '17.82',
    mxn_amount: '1782.00', spei_reference: 'SPEI-001', error_message: null,
    tx_hash: '0xtx', block_number: '123', created_at: new Date().toISOString(),
    resolved_at: null, updated_at: new Date().toISOString(),
  };

  it('returns paginated remittances with total count', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn()
      .mockResolvedValueOnce([mockRow, mockRow])  // rows query
      .mockResolvedValueOnce([{ count: '2' }]);   // count query
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/remittances',
      headers: adminHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it('passes status filter', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn()
      .mockResolvedValueOnce([mockRow])
      .mockResolvedValueOnce([{ count: '1' }]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/remittances?status=delivered',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for invalid status value', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/remittances?status=invalid_status',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid dateFrom format', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/remittances?dateFrom=31-01-2025',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('respects limit and offset params', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '100' }]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/remittances?limit=10&offset=20',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(10);
    expect(res.json().offset).toBe(20);
  });
});

// ─────────────────────────────────────────────────────
// GET /v1/admin/stuck
// ─────────────────────────────────────────────────────

describe('GET /v1/admin/stuck', () => {
  it('returns stuck remittances with alerting=true', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValue([
      {
        remittance_id: 'rem-stuck-1',
        sender:        '0xsender',
        amount_usdc:   '50.000000',
        mxn_amount:    '891.00',
        minutes_stuck: '23.5',
        updated_at:    new Date(Date.now() - 23.5 * 60 * 1000).toISOString(),
        tx_hash:       '0xtx1',
      },
    ]);
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/stuck',
      headers: adminHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.alerting).toBe(true);
    expect(body.thresholdMinutes).toBe(15);
    expect(body.data[0].remittanceId).toBe('rem-stuck-1');
    expect(body.data[0].minutesStuck).toBe(23.5);
  });

  it('returns alerting=false when no stuck remittances', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/stuck',
      headers: adminHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().alerting).toBe(false);
    expect(res.json().count).toBe(0);
  });

  it('accepts custom ?thresholdMinutes= param', async () => {
    const dbMod = await import('../db/client');
    vi.mocked(dbMod.getDB).mockReturnValue(vi.fn().mockResolvedValue([]) as never);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/stuck?thresholdMinutes=30',
      headers: adminHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().thresholdMinutes).toBe(30);
  });

  it('returns 400 for threshold > 1440 minutes', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/stuck?thresholdMinutes=9999',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────
// GET /v1/admin/queue
// ─────────────────────────────────────────────────────

describe('GET /v1/admin/queue', () => {
  it('returns queue job counts and alert flags', async () => {
    const queueMod = await import('../jobs/remittanceQueue');
    vi.mocked(queueMod.remittanceQueue.getJobCounts).mockResolvedValue({
      waiting:   2,
      active:    1,
      completed: 150,
      failed:    3,
      delayed:   0,
      paused:    0,
    });
    vi.mocked(queueMod.remittanceQueue.isPaused).mockResolvedValue(false);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/queue',
      headers: adminHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.name).toBe('remittances');
    expect(data.counts.waiting).toBe(2);
    expect(data.counts.active).toBe(1);
    expect(data.counts.completed).toBe(150);
    expect(data.counts.failed).toBe(3);
    expect(data.isPaused).toBe(false);
    expect(data.alerts.highFailed).toBe(false);   // 3 < 10
    expect(data.alerts.highWaiting).toBe(false);  // 2 < 50
    expect(data.alerts.workerDown).toBe(false);   // active=1
  });

  it('sets highFailed=true when failed > 10', async () => {
    const queueMod = await import('../jobs/remittanceQueue');
    vi.mocked(queueMod.remittanceQueue.getJobCounts).mockResolvedValue({
      waiting: 0, active: 1, completed: 50, failed: 15, delayed: 0, paused: 0,
    });
    vi.mocked(queueMod.remittanceQueue.isPaused).mockResolvedValue(false);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/queue',
      headers: adminHeaders(),
    });

    expect(res.json().data.alerts.highFailed).toBe(true);
  });

  it('sets workerDown=true when active=0 and waiting>0', async () => {
    const queueMod = await import('../jobs/remittanceQueue');
    vi.mocked(queueMod.remittanceQueue.getJobCounts).mockResolvedValue({
      waiting: 5, active: 0, completed: 50, failed: 0, delayed: 0, paused: 0,
    });
    vi.mocked(queueMod.remittanceQueue.isPaused).mockResolvedValue(false);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/queue',
      headers: adminHeaders(),
    });

    expect(res.json().data.alerts.workerDown).toBe(true);
  });

  it('sets highWaiting=true when waiting > 50', async () => {
    const queueMod = await import('../jobs/remittanceQueue');
    vi.mocked(queueMod.remittanceQueue.getJobCounts).mockResolvedValue({
      waiting: 55, active: 2, completed: 100, failed: 0, delayed: 0, paused: 0,
    });
    vi.mocked(queueMod.remittanceQueue.isPaused).mockResolvedValue(false);

    const app = await buildServer();
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/admin/queue',
      headers: adminHeaders(),
    });

    expect(res.json().data.alerts.highWaiting).toBe(true);
  });
});
