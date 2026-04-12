import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from './logger';

// ── TIPOS ─────────────────────────────────────────────

export type PersonaKYCStatus =
  | 'none'
  | 'pending'
  | 'submitted'
  | 'approved'
  | 'declined'
  | 'under_review';

export interface PersonaInquiry {
  inquiryId:    string;
  sessionToken: string;
  status:       PersonaKYCStatus;
}

export interface PersonaWebhookEvent {
  data: {
    type:       string;
    id:         string;
    attributes: {
      status:  string;
      name?:   string;
      payload?: Record<string, unknown>;
    };
    relationships?: {
      inquiry?: { data: { id: string } };
    };
  };
}

// ── MAPA DE ESTADOS PERSONA → REMEX ──────────────────
const STATUS_MAP: Record<string, PersonaKYCStatus> = {
  created:      'pending',
  pending:      'pending',
  completed:    'submitted',
  approved:     'approved',
  declined:     'declined',
  needs_review: 'under_review',
  // Verification statuses
  passed:       'approved',
  failed:       'declined',
  expired:      'declined',
};

// ── CLIENTE PERSONA ───────────────────────────────────
class PersonaService {
  private client: AxiosInstance;
  private apiKey:        string;
  private templateId:    string;
  private webhookSecret: string;

  constructor() {
    this.apiKey        = process.env.PERSONA_API_KEY        ?? '';
    this.templateId    = process.env.PERSONA_TEMPLATE_ID    ?? '';
    this.webhookSecret = process.env.PERSONA_WEBHOOK_SECRET ?? '';

    this.client = axios.create({
      baseURL: 'https://withpersona.com/api/v1',
      timeout: 15_000,
      headers: {
        'Content-Type':    'application/json',
        'Persona-Version': '2023-01-05',
        'Authorization':   `Bearer ${this.apiKey}`,
      },
    });
  }

  // ── CREAR INQUIRY ─────────────────────────────────
  /**
   * Inicia un nuevo KYC inquiry para un usuario.
   * Devuelve el inquiryId y session token para el SDK de Persona en frontend.
   */
  async createInquiry(walletAddress: string): Promise<PersonaInquiry> {
    logger.info({ walletAddress }, 'Creating Persona inquiry');

    if (!this.apiKey || this.apiKey === 'test') {
      return this.mockCreateInquiry(walletAddress);
    }

    const response = await this.client.post('/inquiries', {
      data: {
        attributes: {
          'inquiry-template-id': this.templateId,
          'reference-id':        walletAddress.toLowerCase(),
        },
      },
    });

    const { id, attributes } = response.data.data;
    const sessionToken = response.data.meta?.['session-token'] ?? '';

    return {
      inquiryId:    id,
      sessionToken,
      status:       this.mapStatus(attributes.status),
    };
  }

  // ── OBTENER ESTADO DEL INQUIRY ────────────────────
  async getInquiry(inquiryId: string): Promise<PersonaInquiry> {
    if (!this.apiKey || this.apiKey === 'test') {
      return {
        inquiryId,
        sessionToken: '',
        status: 'pending',
      };
    }

    const response = await this.client.get(`/inquiries/${inquiryId}`);
    const { id, attributes } = response.data.data;

    return {
      inquiryId:    id,
      sessionToken: '',
      status:       this.mapStatus(attributes.status),
    };
  }

  // ── VERIFICAR FIRMA DEL WEBHOOK ───────────────────
  /**
   * Persona firma cada webhook con HMAC-SHA256.
   * Header: Persona-Signature: t=<timestamp>,v1=<hmac>
   *
   * FinCEN: Este log es audit trail — NUNCA ignorar errores de firma.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    // Read at call time so tests can set env vars after module import
    const secret = this.webhookSecret || process.env.PERSONA_WEBHOOK_SECRET || '';
    if (!secret) {
      logger.error('PERSONA_WEBHOOK_SECRET not configured — rejecting all webhooks (FinCEN audit requirement)');
      return false;
    }

    try {
      const parts = Object.fromEntries(
        signatureHeader.split(',').map((p) => p.split('=')),
      ) as Record<string, string>;

      const timestamp = parts['t'];
      const signature = parts['v1'];

      if (!timestamp || !signature) return false;

      // Persona: signed payload = timestamp + '.' + rawBody
      const signedPayload = `${timestamp}.${rawBody}`;
      const expected = crypto
        .createHmac('sha256', secret)
        .update(signedPayload)
        .digest('hex');

      // Constant-time comparison para evitar timing attacks
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected,  'hex'),
      );
    } catch {
      return false;
    }
  }

  // ── EXTRAER NOMBRE DEL WEBHOOK ────────────────────
  extractNameFromWebhook(event: PersonaWebhookEvent): string | undefined {
    const attrs = event.data.attributes;
    if (attrs.name) return attrs.name;
    const payload = attrs.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload['name-first'] === 'string') {
      return `${payload['name-first']} ${payload['name-last'] ?? ''}`.trim();
    }
    return undefined;
  }

  mapStatus(personaStatus: string): PersonaKYCStatus {
    return STATUS_MAP[personaStatus] ?? 'pending';
  }

  // ── MOCKS PARA DESARROLLO ─────────────────────────
  private mockCreateInquiry(walletAddress: string): PersonaInquiry {
    logger.warn({ walletAddress }, '[MOCK] Using simulated Persona inquiry');
    return {
      inquiryId:    `inq_mock_${Date.now()}`,
      sessionToken: `session_mock_${crypto.randomBytes(16).toString('hex')}`,
      status:       'pending',
    };
  }
}

export const personaService = new PersonaService();
