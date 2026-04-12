import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios');
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('ResendService.sendStatusEmail', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const baseParams = {
    to:           'sender@example.com',
    senderName:   'Carlos',
    remittanceId: 'rem-001',
    amountUsdc:   100,
    mxnAmount:    1782,
    fxRate:       17.82,
    status:       'delivered' as const,
  };

  it('calls Resend API with correct payload when API key is set', async () => {
    process.env.RESEND_API_KEY = 'real-key';
    const axios  = await import('axios');
    const mockPost = vi.fn().mockResolvedValue({ data: { id: 'email-123' } });
    vi.mocked(axios.default).post = mockPost;

    const { resendService } = await import('./resend');
    await resendService.sendStatusEmail(baseParams);

    expect(mockPost).toHaveBeenCalledOnce();
    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(body.to).toEqual(['sender@example.com']);
    expect(body.html).toContain('Carlos');
    expect(body.html).toContain('100.00');
    expect(body.html).toContain('1782.00');
    expect((config as { headers: Record<string, string> }).headers['Authorization']).toContain('real-key');
  });

  it('uses mock mode when RESEND_API_KEY is "test"', async () => {
    process.env.RESEND_API_KEY = 'test';
    const axios = await import('axios');
    const mockPost = vi.fn();
    vi.mocked(axios.default).post = mockPost;

    const { resendService } = await import('./resend');
    await resendService.sendStatusEmail(baseParams);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('uses mock mode when RESEND_API_KEY is empty', async () => {
    process.env.RESEND_API_KEY = '';
    const axios = await import('axios');
    const mockPost = vi.fn();
    vi.mocked(axios.default).post = mockPost;

    const { resendService } = await import('./resend');
    await resendService.sendStatusEmail(baseParams);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it.each(['processing', 'delivered', 'refunded'] as const)(
    'builds HTML email for status "%s" without throwing',
    async (status) => {
      process.env.RESEND_API_KEY = 'key';
      const axios = await import('axios');
      vi.mocked(axios.default).post = vi.fn().mockResolvedValue({});

      const { resendService } = await import('./resend');
      await expect(
        resendService.sendStatusEmail({ ...baseParams, status }),
      ).resolves.toBeUndefined();
    },
  );
});
