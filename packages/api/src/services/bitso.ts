import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from './logger';

// ── TIPOS ─────────────────────────────────────────────
interface FXQuote {
  quoteId:   string;
  rate:      number;
  mxnAmount: number;
  expiresAt: string;
}

interface SPEIPayoutResult {
  speiReference: string;
  status:        string;
  estimatedTime: string;
}

interface SPEIPayoutParams {
  quoteId:   string;
  mxnAmount: number;
  clabeHash: string;
  reference: string;
}

// ── CLIENTE BITSO BUSINESS ────────────────────────────
class BitsoService {
  private client: AxiosInstance;
  private apiKey:    string;
  private apiSecret: string;

  constructor() {
    this.apiKey    = process.env.BITSO_API_KEY    ?? '';
    this.apiSecret = process.env.BITSO_API_SECRET ?? '';

    this.client = axios.create({
      baseURL: process.env.BITSO_API_URL ?? 'https://api.bitso.com',
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Interceptor: firma cada request con HMAC-SHA256
    this.client.interceptors.request.use((config) => {
      const nonce     = Date.now().toString();
      const method    = config.method!.toUpperCase();
      const path      = new URL(config.url!, config.baseURL).pathname;
      const body      = config.data ? JSON.stringify(config.data) : '';
      const message   = `${nonce}${method}${path}${body}`;
      const signature = crypto
        .createHmac('sha256', this.apiSecret)
        .update(message)
        .digest('hex');

      config.headers['Authorization'] =
        `Bitso ${this.apiKey}:${nonce}:${signature}`;

      return config;
    });
  }

  // ── GET FX QUOTE ──────────────────────────────────
  /**
   * Obtiene cotización USDC → MXN con lock de precio (válido 30s).
   * Endpoint real: POST /v3/fx/quote
   */
  async getFXQuote(usdcAmount: number): Promise<FXQuote> {
    logger.info({ usdcAmount }, 'Requesting FX quote from Bitso');

    // En desarrollo sin credenciales reales, usamos mock
    if (!this.apiKey || this.apiKey === 'test') {
      return this.mockFXQuote(usdcAmount);
    }

    const response = await this.client.post('/v3/fx/quote', {
      origin_currency: 'USDC',
      target_currency: 'MXN',
      origin_amount:   usdcAmount.toFixed(6),
    });

    const { data } = response.data;
    return {
      quoteId:   data.quote_id,
      rate:      parseFloat(data.rate),
      mxnAmount: parseFloat(data.target_amount),
      expiresAt: data.expires_at,
    };
  }

  // ── SEND SPEI PAYOUT ──────────────────────────────
  /**
   * Ejecuta el pago SPEI al banco del destinatario en México.
   * Endpoint real: POST /v3/spei_payout
   */
  async sendSPEIPayout(params: SPEIPayoutParams): Promise<SPEIPayoutResult> {
    logger.info({ reference: params.reference }, 'Sending SPEI payout via Bitso');

    if (!this.apiKey || this.apiKey === 'test') {
      return this.mockSPEIPayout(params);
    }

    const response = await this.client.post('/v3/spei_payout', {
      quote_id:       params.quoteId,
      amount:         params.mxnAmount.toFixed(2),
      currency:       'MXN',
      clabe:          params.clabeHash, // El backend resuelve el hash a CLABE real
      payment_concept: params.reference,
      numeric_reference: params.reference.replace('REMEX-', ''),
    });

    const { data } = response.data;
    return {
      speiReference: data.spei_reference ?? data.wid,
      status:        data.status,
      estimatedTime: data.estimated_arrival ?? '< 2 minutos',
    };
  }

  // ── MOCKS PARA DESARROLLO ─────────────────────────
  private mockFXQuote(usdcAmount: number): FXQuote {
    const rate = 17.82 + (Math.random() - 0.5) * 0.1; // Simula variación
    logger.warn({ usdcAmount }, '[MOCK] Using simulated FX quote');
    return {
      quoteId:   `mock-quote-${Date.now()}`,
      rate:      parseFloat(rate.toFixed(4)),
      mxnAmount: parseFloat((usdcAmount * rate).toFixed(2)),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }

  private mockSPEIPayout(params: SPEIPayoutParams): SPEIPayoutResult {
    logger.warn({ reference: params.reference }, '[MOCK] Using simulated SPEI payout');
    return {
      speiReference: `SPEI-MOCK-${Date.now()}`,
      status:        'completed',
      estimatedTime: '< 2 minutos',
    };
  }
}

export const bitsoService = new BitsoService();