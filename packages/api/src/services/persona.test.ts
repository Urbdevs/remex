import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';

// Importamos la clase internamente para poder instanciarla con mocks
// En producción se usa el singleton personaService

// ── STATUS MAPPING ────────────────────────────────────

describe('PersonaService.mapStatus', () => {
  // Probamos el mapa directamente importando el servicio (modo MOCK porque PERSONA_API_KEY está vacía)
  it('maps approved → approved', async () => {
    const { personaService } = await import('./persona');
    expect(personaService.mapStatus('approved')).toBe('approved');
  });

  it('maps declined → declined', async () => {
    const { personaService } = await import('./persona');
    expect(personaService.mapStatus('declined')).toBe('declined');
  });

  it('maps completed → submitted', async () => {
    const { personaService } = await import('./persona');
    expect(personaService.mapStatus('completed')).toBe('submitted');
  });

  it('maps needs_review → under_review', async () => {
    const { personaService } = await import('./persona');
    expect(personaService.mapStatus('needs_review')).toBe('under_review');
  });

  it('maps unknown status → pending (safe default)', async () => {
    const { personaService } = await import('./persona');
    expect(personaService.mapStatus('something_new')).toBe('pending');
  });
});

// ── WEBHOOK SIGNATURE ─────────────────────────────────

describe('PersonaService.verifyWebhookSignature', () => {
  const webhookSecret = 'test-webhook-secret-for-unit-tests';

  function buildSignatureHeader(rawBody: string, secret: string): string {
    const timestamp = Date.now().toString();
    const signedPayload = `${timestamp}.${rawBody}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  it('accepts valid HMAC-SHA256 signature', async () => {
    process.env.PERSONA_WEBHOOK_SECRET = webhookSecret;
    const { personaService } = await import('./persona');

    const rawBody = JSON.stringify({ data: { type: 'inquiry.approved' } });
    const header  = buildSignatureHeader(rawBody, webhookSecret);

    expect(personaService.verifyWebhookSignature(rawBody, header)).toBe(true);
  });

  it('rejects tampered body', async () => {
    process.env.PERSONA_WEBHOOK_SECRET = webhookSecret;
    const { personaService } = await import('./persona');

    const rawBody   = JSON.stringify({ data: { type: 'inquiry.approved' } });
    const header    = buildSignatureHeader(rawBody, webhookSecret);
    const tamperedBody = JSON.stringify({ data: { type: 'inquiry.declined' } });

    expect(personaService.verifyWebhookSignature(tamperedBody, header)).toBe(false);
  });

  it('rejects wrong secret', async () => {
    process.env.PERSONA_WEBHOOK_SECRET = webhookSecret;
    const { personaService } = await import('./persona');

    const rawBody = JSON.stringify({ data: { type: 'inquiry.approved' } });
    const header  = buildSignatureHeader(rawBody, 'wrong-secret');

    expect(personaService.verifyWebhookSignature(rawBody, header)).toBe(false);
  });

  it('rejects malformed header', async () => {
    process.env.PERSONA_WEBHOOK_SECRET = webhookSecret;
    const { personaService } = await import('./persona');
    expect(personaService.verifyWebhookSignature('{}', 'not-a-valid-header')).toBe(false);
  });

  it('rejects header missing v1 part', async () => {
    process.env.PERSONA_WEBHOOK_SECRET = webhookSecret;
    const { personaService } = await import('./persona');
    expect(personaService.verifyWebhookSignature('{}', 't=12345')).toBe(false);
  });

  it('returns false in ALL environments when PERSONA_WEBHOOK_SECRET is not set', async () => {
    delete process.env.PERSONA_WEBHOOK_SECRET;
    // Force fresh module so the constructor re-reads env
    const { personaService: svc } = await import('./persona');

    const rawBody = JSON.stringify({ data: { type: 'inquiry.approved' } });
    const header  = buildSignatureHeader(rawBody, 'any-secret');

    // Must fail regardless of NODE_ENV — no bypass allowed
    const originalEnv = process.env.NODE_ENV;
    for (const env of ['development', 'test', 'production']) {
      process.env.NODE_ENV = env;
      expect(svc.verifyWebhookSignature(rawBody, header)).toBe(false);
    }
    process.env.NODE_ENV = originalEnv;
  });
});

// ── EXTRACT NAME FROM WEBHOOK ─────────────────────────

describe('PersonaService.extractNameFromWebhook', () => {
  it('extracts name from attributes.name', async () => {
    const { personaService } = await import('./persona');
    const event = {
      data: {
        type: 'inquiry.approved',
        id:   'inq_123',
        attributes: { status: 'approved', name: 'John Doe' },
      },
    };
    expect(personaService.extractNameFromWebhook(event as never)).toBe('John Doe');
  });

  it('extracts name from payload fields', async () => {
    const { personaService } = await import('./persona');
    const event = {
      data: {
        type: 'inquiry.approved',
        id:   'inq_123',
        attributes: {
          status:  'approved',
          payload: { 'name-first': 'Maria', 'name-last': 'Garcia' },
        },
      },
    };
    expect(personaService.extractNameFromWebhook(event as never)).toBe('Maria Garcia');
  });

  it('returns undefined when no name present', async () => {
    const { personaService } = await import('./persona');
    const event = {
      data: {
        type:       'inquiry.approved',
        id:         'inq_123',
        attributes: { status: 'approved' },
      },
    };
    expect(personaService.extractNameFromWebhook(event as never)).toBeUndefined();
  });
});
