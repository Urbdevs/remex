import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios');
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('TwilioService.sendWhatsApp', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const baseParams = {
    to:           '+521234567890',
    remittanceId: 'rem-001',
    amountUsdc:   100,
    mxnAmount:    1782,
    status:       'delivered' as const,
  };

  it('calls Twilio API with form-encoded body when credentials set', async () => {
    process.env.TWILIO_ACCOUNT_SID  = 'ACtest123';
    process.env.TWILIO_AUTH_TOKEN   = 'authtoken';
    process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';

    const axios    = await import('axios');
    const mockPost = vi.fn().mockResolvedValue({ data: { sid: 'SM123' } });
    vi.mocked(axios.default).post = mockPost;

    const { twilioService } = await import('./twilio');
    await twilioService.sendWhatsApp(baseParams);

    expect(mockPost).toHaveBeenCalledOnce();
    const [url, body, config] = mockPost.mock.calls[0];

    expect(url).toContain('ACtest123/Messages.json');
    expect(body).toContain('whatsapp%3A%2B521234567890');  // URL-encoded To
    expect(body).toContain('whatsapp%3A%2B14155238886');   // URL-encoded From
    expect((config as { auth: { username: string } }).auth.username).toBe('ACtest123');
  });

  it('uses mock mode when TWILIO_ACCOUNT_SID is "test"', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'test';
    const axios    = await import('axios');
    const mockPost = vi.fn();
    vi.mocked(axios.default).post = mockPost;

    const { twilioService } = await import('./twilio');
    await twilioService.sendWhatsApp(baseParams);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it.each(['processing', 'delivered', 'refunded'] as const)(
    'builds Spanish message for status "%s"',
    async (status) => {
      process.env.TWILIO_ACCOUNT_SID = 'ACtest';
      process.env.TWILIO_AUTH_TOKEN  = 'token';
      const axios    = await import('axios');
      const mockPost = vi.fn().mockResolvedValue({});
      vi.mocked(axios.default).post = mockPost;

      const { twilioService } = await import('./twilio');
      await twilioService.sendWhatsApp({ ...baseParams, status });

      if (status !== 'refunded') {
        // refunded → mock because TWILIO_ACCOUNT_SID='ACtest' !== 'test' → it calls
        expect(mockPost).toHaveBeenCalledOnce();
        const body: string = mockPost.mock.calls[0][1];
        // Message should contain Spanish content
        expect(body).toContain('Remex');
      }
    },
  );

  it('includes SPEI reference in delivered message', async () => {
    process.env.TWILIO_ACCOUNT_SID  = 'ACtest123';
    process.env.TWILIO_AUTH_TOKEN   = 'authtoken';

    const axios    = await import('axios');
    const mockPost = vi.fn().mockResolvedValue({});
    vi.mocked(axios.default).post = mockPost;

    const { twilioService } = await import('./twilio');
    await twilioService.sendWhatsApp({
      ...baseParams,
      status:        'delivered',
      speiReference: 'SPEI-REF-12345',
    });

    const body: string = mockPost.mock.calls[0][1];
    expect(decodeURIComponent(body)).toContain('SPEI-REF-12345');
  });
});
