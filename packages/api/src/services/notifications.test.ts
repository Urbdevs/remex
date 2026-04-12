import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── MOCKS ─────────────────────────────────────────────

vi.mock('../db/client', () => ({ getDB: vi.fn() }));
vi.mock('./resend',     () => ({ resendService:  { sendStatusEmail: vi.fn() } }));
vi.mock('./twilio',     () => ({ twilioService:  { sendWhatsApp:    vi.fn() } }));
vi.mock('./logger',     () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./pagerduty', () => ({ alertPagerDuty: vi.fn() }));

// ── HELPERS ───────────────────────────────────────────

const VALID_KEY   = 'a'.repeat(64);
const PHONE       = '+521234567890';
const EMAIL       = 'sender@example.com';
const REMITTANCE  = 'rem-001';
const CLABE_HASH  = '0x' + 'b'.repeat(64);

function encryptPhone(): string {
  // Use the real crypto module to produce a valid ciphertext for tests
  const crypto = require('crypto') as typeof import('crypto');
  const key    = Buffer.from(VALID_KEY, 'hex');
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct     = Buffer.concat([cipher.update(PHONE, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function makeRemittanceRow(overrides = {}) {
  return {
    remittance_id:  REMITTANCE,
    sender:         '0xsender',
    amount_usdc:    '100000000', // 100 USDC
    clabe_hash:     CLABE_HASH,
    mxn_amount:     '1782.00',
    fx_rate:        '17.82',
    spei_reference: 'SPEI-001',
    ...overrides,
  };
}

// ── TESTS ─────────────────────────────────────────────

describe('dispatchNotifications', () => {
  beforeEach(() => {
    process.env.NOTIFICATION_ENCRYPTION_KEY = VALID_KEY;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('sends email and WhatsApp on "processing"', async () => {
    const dbMod      = await import('../db/client');
    const resendMod  = await import('./resend');
    const twilioMod  = await import('./twilio');

    const phoneEnc = encryptPhone();
    const mockSql  = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])      // fetch remittance
      .mockResolvedValueOnce([])                         // alreadySent email
      .mockResolvedValueOnce([{ email: EMAIL, full_name: 'Carlos' }]) // fetch user
      .mockResolvedValueOnce([])                         // sendStatusEmail log
      .mockResolvedValueOnce([])                         // alreadySent whatsapp
      .mockResolvedValueOnce([{ phone_enc: phoneEnc }])  // fetch contact
      .mockResolvedValueOnce([]);                        // whatsapp log

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockResolvedValue(undefined);
    vi.mocked(twilioMod.twilioService.sendWhatsApp).mockResolvedValue(undefined);

    const { dispatchNotifications } = await import('./notifications');
    await dispatchNotifications(REMITTANCE, 'processing');

    expect(resendMod.resendService.sendStatusEmail).toHaveBeenCalledOnce();
    expect(twilioMod.twilioService.sendWhatsApp).toHaveBeenCalledOnce();

    const emailCall = vi.mocked(resendMod.resendService.sendStatusEmail).mock.calls[0][0];
    expect(emailCall.status).toBe('processing');
    expect(emailCall.amountUsdc).toBe(100); // 100_000_000 / 1_000_000

    const waCall = vi.mocked(twilioMod.twilioService.sendWhatsApp).mock.calls[0][0];
    expect(waCall.to).toBe(PHONE);
    expect(waCall.status).toBe('processing');
  });

  it('sends email and WhatsApp on "delivered"', async () => {
    const dbMod      = await import('../db/client');
    const resendMod  = await import('./resend');
    const twilioMod  = await import('./twilio');

    const phoneEnc = encryptPhone();
    const mockSql  = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: EMAIL, full_name: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ phone_enc: phoneEnc }])
      .mockResolvedValueOnce([]);

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockResolvedValue(undefined);
    vi.mocked(twilioMod.twilioService.sendWhatsApp).mockResolvedValue(undefined);

    const { dispatchNotifications } = await import('./notifications');
    await dispatchNotifications(REMITTANCE, 'delivered');

    expect(resendMod.resendService.sendStatusEmail).toHaveBeenCalledOnce();
    expect(twilioMod.twilioService.sendWhatsApp).toHaveBeenCalledOnce();
  });

  it('sends ONLY email on "refunded" (no WhatsApp to recipient)', async () => {
    const dbMod     = await import('../db/client');
    const resendMod = await import('./resend');
    const twilioMod = await import('./twilio');

    const mockSql = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: EMAIL, full_name: 'Carlos' }])
      .mockResolvedValueOnce([]);

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockResolvedValue(undefined);

    const { dispatchNotifications } = await import('./notifications');
    await dispatchNotifications(REMITTANCE, 'refunded');

    expect(resendMod.resendService.sendStatusEmail).toHaveBeenCalledOnce();
    expect(twilioMod.twilioService.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('skips email when sender has no email registered', async () => {
    const dbMod     = await import('../db/client');
    const resendMod = await import('./resend');
    const twilioMod = await import('./twilio');

    const phoneEnc = encryptPhone();
    const mockSql  = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: null, full_name: null }]) // no email
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ phone_enc: phoneEnc }])
      .mockResolvedValueOnce([]);

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(twilioMod.twilioService.sendWhatsApp).mockResolvedValue(undefined);

    const { dispatchNotifications } = await import('./notifications');
    await dispatchNotifications(REMITTANCE, 'processing');

    expect(resendMod.resendService.sendStatusEmail).not.toHaveBeenCalled();
    expect(twilioMod.twilioService.sendWhatsApp).toHaveBeenCalledOnce();
  });

  it('skips WhatsApp when no recipient contact registered', async () => {
    const dbMod     = await import('../db/client');
    const resendMod = await import('./resend');
    const twilioMod = await import('./twilio');

    const mockSql = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: EMAIL, full_name: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // no contact found

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockResolvedValue(undefined);

    const { dispatchNotifications } = await import('./notifications');
    await dispatchNotifications(REMITTANCE, 'delivered');

    expect(resendMod.resendService.sendStatusEmail).toHaveBeenCalledOnce();
    expect(twilioMod.twilioService.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('deduplicates: skips if notification already sent', async () => {
    const dbMod     = await import('../db/client');
    const resendMod = await import('./resend');
    const twilioMod = await import('./twilio');

    const mockSql = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([{ id: '1' }])  // email already sent
      .mockResolvedValueOnce([{ id: '2' }]); // whatsapp already sent

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const { dispatchNotifications } = await import('./notifications');
    await dispatchNotifications(REMITTANCE, 'delivered');

    expect(resendMod.resendService.sendStatusEmail).not.toHaveBeenCalled();
    expect(twilioMod.twilioService.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('does NOT throw when remittance not found — fire-and-forget', async () => {
    const dbMod = await import('../db/client');
    const mockSql = vi.fn().mockResolvedValueOnce([]); // no remittance
    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);

    const { dispatchNotifications } = await import('./notifications');
    await expect(dispatchNotifications('non-existent', 'delivered')).resolves.toBeUndefined();
  });

  it('does NOT throw when email send fails — fire-and-forget', async () => {
    const dbMod     = await import('../db/client');
    const resendMod = await import('./resend');

    const mockSql = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: EMAIL, full_name: null }])
      .mockResolvedValueOnce([]);  // log insert

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockRejectedValue(new Error('Resend down'));

    const { dispatchNotifications } = await import('./notifications');
    await expect(dispatchNotifications(REMITTANCE, 'refunded')).resolves.toBeUndefined();
  });

  it('does NOT throw when WhatsApp send fails — fire-and-forget', async () => {
    const dbMod     = await import('../db/client');
    const resendMod = await import('./resend');
    const twilioMod = await import('./twilio');

    const phoneEnc = encryptPhone();
    const mockSql  = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: EMAIL, full_name: null }])
      .mockResolvedValueOnce([])  // email log
      .mockResolvedValueOnce([])  // whatsapp alreadySent
      .mockResolvedValueOnce([{ phone_enc: phoneEnc }])
      .mockResolvedValueOnce([])  // whatsapp log
      .mockResolvedValueOnce([{ n: '1' }]); // countFailures → 1, no PD alert

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockResolvedValue(undefined);
    vi.mocked(twilioMod.twilioService.sendWhatsApp).mockRejectedValue(new Error('Twilio down'));

    const { dispatchNotifications } = await import('./notifications');
    await expect(dispatchNotifications(REMITTANCE, 'processing')).resolves.toBeUndefined();
  });

  // ── PAGERDUTY THRESHOLD ───────────────────────────────

  it('fires PagerDuty when email fails for the 3rd time', async () => {
    const dbMod  = await import('../db/client');
    const resendMod = await import('./resend');
    const pdMod  = await import('./pagerduty');

    const mockSql = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])  // fetch remittance
      .mockResolvedValueOnce([])                     // alreadySent email
      .mockResolvedValueOnce([{ email: EMAIL, full_name: null }]) // fetch user
      .mockResolvedValueOnce([])                     // logNotification (failed)
      .mockResolvedValueOnce([{ n: '3' }]);          // countFailures → 3 → alert!

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockRejectedValue(new Error('Resend down'));
    vi.mocked(pdMod.alertPagerDuty).mockResolvedValue(undefined);

    const { dispatchNotifications } = await import('./notifications');
    await dispatchNotifications(REMITTANCE, 'refunded');

    expect(pdMod.alertPagerDuty).toHaveBeenCalledOnce();
    const [summary, details] = vi.mocked(pdMod.alertPagerDuty).mock.calls[0];
    expect(summary).toMatch(/Email notification failed 3 times/);
    expect(details.channel).toBe('email');
    expect(details.remittanceId).toBe(REMITTANCE);
  });

  it('does NOT fire PagerDuty when email fails for the 1st or 2nd time', async () => {
    const dbMod  = await import('../db/client');
    const resendMod = await import('./resend');
    const pdMod  = await import('./pagerduty');

    for (const n of ['1', '2']) {
      vi.clearAllMocks();
      const mockSql = vi.fn()
        .mockResolvedValueOnce([makeRemittanceRow()])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ email: EMAIL, full_name: null }])
        .mockResolvedValueOnce([])          // logNotification
        .mockResolvedValueOnce([{ n }]);    // countFailures → 1 or 2

      vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
      vi.mocked(resendMod.resendService.sendStatusEmail).mockRejectedValue(new Error('Resend down'));

      const { dispatchNotifications } = await import('./notifications');
      await dispatchNotifications(REMITTANCE, 'refunded');

      expect(pdMod.alertPagerDuty).not.toHaveBeenCalled();
    }
  });

  it('fires PagerDuty when WhatsApp fails for the 3rd time', async () => {
    const dbMod     = await import('../db/client');
    const resendMod = await import('./resend');
    const twilioMod = await import('./twilio');
    const pdMod     = await import('./pagerduty');

    const phoneEnc = encryptPhone();
    const mockSql  = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([])                      // alreadySent email
      .mockResolvedValueOnce([{ email: EMAIL, full_name: null }])
      .mockResolvedValueOnce([])                      // email log
      .mockResolvedValueOnce([])                      // alreadySent whatsapp
      .mockResolvedValueOnce([{ phone_enc: phoneEnc }])
      .mockResolvedValueOnce([])                      // whatsapp log
      .mockResolvedValueOnce([{ n: '3' }]);            // countFailures → 3 → alert!

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockResolvedValue(undefined);
    vi.mocked(twilioMod.twilioService.sendWhatsApp).mockRejectedValue(new Error('Twilio down'));
    vi.mocked(pdMod.alertPagerDuty).mockResolvedValue(undefined);

    const { dispatchNotifications } = await import('./notifications');
    await dispatchNotifications(REMITTANCE, 'processing');

    expect(pdMod.alertPagerDuty).toHaveBeenCalledOnce();
    const [summary, details] = vi.mocked(pdMod.alertPagerDuty).mock.calls[0];
    expect(summary).toMatch(/WhatsApp notification failed 3 times/);
    expect(details.channel).toBe('whatsapp');
  });

  it('does NOT throw when PagerDuty itself fails — non-fatal', async () => {
    const dbMod     = await import('../db/client');
    const resendMod = await import('./resend');
    const pdMod     = await import('./pagerduty');

    const mockSql = vi.fn()
      .mockResolvedValueOnce([makeRemittanceRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: EMAIL, full_name: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ n: '3' }]);

    vi.mocked(dbMod.getDB).mockReturnValue(mockSql as never);
    vi.mocked(resendMod.resendService.sendStatusEmail).mockRejectedValue(new Error('Resend down'));
    vi.mocked(pdMod.alertPagerDuty).mockRejectedValue(new Error('PD unreachable'));

    const { dispatchNotifications } = await import('./notifications');
    await expect(dispatchNotifications(REMITTANCE, 'refunded')).resolves.toBeUndefined();
  });
});
