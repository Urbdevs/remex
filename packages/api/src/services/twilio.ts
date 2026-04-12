import axios from 'axios';
import { logger } from './logger';
import { maskPhone } from './crypto';

// ── TIPOS ─────────────────────────────────────────────

export type RemittanceStatus = 'processing' | 'delivered' | 'refunded';

export interface WhatsAppParams {
  to:            string;  // E.164 format: +521234567890
  remittanceId:  string;
  amountUsdc:    number;
  mxnAmount?:    number;
  speiReference?: string;
  status:        RemittanceStatus;
}

// ── MENSAJES EN ESPAÑOL ───────────────────────────────
// Twilio Sandbox usa free-form. En producción se requieren
// plantillas pre-aprobadas por Meta (WhatsApp Business API).

function buildMessage(params: WhatsAppParams): string {
  const usd = params.amountUsdc.toFixed(2);
  const mxn = params.mxnAmount?.toFixed(2) ?? '—';

  switch (params.status) {
    case 'processing':
      return (
        `💸 *Remex:* Tu familia te está enviando dinero desde USA.\n\n` +
        `Monto: *${usd} USD* → ~*$${mxn} MXN*\n` +
        `Estado: En procesamiento ⏳\n\n` +
        `Los fondos llegan en menos de 2 minutos vía SPEI.`
      );

    case 'delivered':
      return (
        `✅ *Remex:* ¡Tu dinero ha llegado!\n\n` +
        `Monto depositado: *$${mxn} MXN*\n` +
        (params.speiReference
          ? `Referencia SPEI: ${params.speiReference}\n\n`
          : '\n') +
        `Revisa tu cuenta bancaria.`
      );

    case 'refunded':
      return (
        `⚠️ *Remex:* La transferencia de *${usd} USD* no pudo completarse.\n\n` +
        `El dinero fue devuelto al emisor en USA.\n` +
        `Por favor, pide que intenten de nuevo.`
      );
  }
}

// ── CLIENTE TWILIO ────────────────────────────────────

class TwilioService {
  private accountSid:  string;
  private authToken:   string;
  private fromNumber:  string;  // whatsapp:+14155238886 (Twilio sandbox)

  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID ?? '';
    this.authToken  = process.env.TWILIO_AUTH_TOKEN  ?? '';
    this.fromNumber = process.env.TWILIO_WHATSAPP_FROM ?? 'whatsapp:+14155238886';
  }

  async sendWhatsApp(params: WhatsAppParams): Promise<void> {
    logger.info(
      { to: maskPhone(params.to), remittanceId: params.remittanceId, status: params.status },
      'Sending WhatsApp notification',
    );

    if (!this.accountSid || this.accountSid === 'test') {
      this.mockSend(params);
      return;
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const body = new URLSearchParams({
      From: this.fromNumber,
      To:   `whatsapp:${params.to}`,
      Body: buildMessage(params),
    });

    await axios.post(url, body.toString(), {
      auth:    { username: this.accountSid, password: this.authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });

    logger.info(
      { to: maskPhone(params.to), remittanceId: params.remittanceId },
      'WhatsApp sent',
    );
  }

  private mockSend(params: WhatsAppParams): void {
    logger.warn(
      { to: maskPhone(params.to), remittanceId: params.remittanceId, status: params.status },
      '[MOCK] WhatsApp notification (TWILIO credentials not set)',
    );
  }
}

export const twilioService = new TwilioService();
