import axios from 'axios';
import { logger } from './logger';
import { maskEmail } from './crypto';

// ── TIPOS ─────────────────────────────────────────────

export type RemittanceStatus = 'processing' | 'delivered' | 'refunded';

export interface SenderEmailParams {
  to:            string;   // Sender email address
  senderName:    string;
  remittanceId:  string;
  amountUsdc:    number;
  mxnAmount?:    number;
  fxRate?:       number;
  speiReference?: string;
  status:        RemittanceStatus;
}

// ── TEMPLATES ─────────────────────────────────────────

const SUBJECTS: Record<RemittanceStatus, string> = {
  processing: 'Your remittance is being processed — Remex',
  delivered:  'Money delivered! Your remittance arrived — Remex',
  refunded:   'Remittance refunded — Remex',
};

function buildEmailHtml(params: SenderEmailParams): string {
  const usdFormatted = params.amountUsdc.toFixed(2);
  const mxnFormatted = params.mxnAmount?.toFixed(2) ?? '—';
  const rateFormatted = params.fxRate?.toFixed(4) ?? '—';

  const statusBlock: Record<RemittanceStatus, string> = {
    processing: `
      <p>Your transfer of <strong>${usdFormatted} USDC</strong> is being converted and
      sent via SPEI to Mexico.</p>
      <p>Your recipient will receive approximately
      <strong>MX$${mxnFormatted}</strong> at a rate of
      <strong>${rateFormatted} MXN/USD</strong>.</p>
      <p>Funds typically arrive in <strong>under 2 minutes</strong>.</p>`,

    delivered: `
      <p>Your transfer of <strong>${usdFormatted} USDC</strong> has been
      <strong style="color:#16a34a">successfully delivered</strong>!</p>
      <p>Amount deposited: <strong>MX$${mxnFormatted}</strong></p>
      ${params.speiReference
        ? `<p>SPEI Reference: <code>${params.speiReference}</code></p>`
        : ''}`,

    refunded: `
      <p>Your transfer of <strong>${usdFormatted} USDC</strong> could not be completed
      and has been <strong style="color:#dc2626">refunded</strong> to your wallet.</p>
      <p>The USDC has been returned to your Base L2 address.</p>
      <p>If you have questions, please contact support.</p>`,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1f2937">
  <div style="border-bottom:2px solid #2563eb;padding-bottom:16px;margin-bottom:24px">
    <h1 style="margin:0;color:#2563eb;font-size:24px">Remex</h1>
    <p style="margin:4px 0 0;color:#6b7280;font-size:13px">USA → México remittances</p>
  </div>
  <p>Hi ${params.senderName || 'there'},</p>
  ${statusBlock[params.status]}
  <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:24px 0;font-size:13px;color:#374151">
    <strong>Transfer ID:</strong> ${params.remittanceId}
  </div>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="font-size:12px;color:#9ca3af">
    You're receiving this because you sent a remittance via Remex.<br>
    © ${new Date().getFullYear()} Remex. All rights reserved.
  </p>
</body>
</html>`;
}

// ── CLIENTE RESEND ────────────────────────────────────

class ResendService {
  private apiKey: string;
  private fromAddress: string;

  constructor() {
    this.apiKey      = process.env.RESEND_API_KEY   ?? '';
    this.fromAddress = process.env.RESEND_FROM      ?? 'notifications@remex.mx';
  }

  async sendStatusEmail(params: SenderEmailParams): Promise<void> {
    logger.info(
      { to: maskEmail(params.to), remittanceId: params.remittanceId, status: params.status },
      'Sending status email',
    );

    if (!this.apiKey || this.apiKey === 'test') {
      this.mockSend(params);
      return;
    }

    await axios.post(
      'https://api.resend.com/emails',
      {
        from:    this.fromAddress,
        to:      [params.to],
        subject: SUBJECTS[params.status],
        html:    buildEmailHtml(params),
      },
      {
        headers: {
          Authorization:  `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );

    logger.info(
      { to: maskEmail(params.to), remittanceId: params.remittanceId },
      'Status email sent',
    );
  }

  private mockSend(params: SenderEmailParams): void {
    logger.warn(
      { to: maskEmail(params.to), remittanceId: params.remittanceId, status: params.status },
      '[MOCK] Email notification (RESEND_API_KEY not set)',
    );
  }
}

export const resendService = new ResendService();
