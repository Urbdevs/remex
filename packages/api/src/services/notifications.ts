import { getDB } from '../db/client';
import { resendService } from './resend';
import { twilioService } from './twilio';
import { decrypt, maskEmail, maskPhone } from './crypto';
import { logger } from './logger';
import { alertPagerDuty } from './pagerduty';
import type { RemittanceStatus } from './resend';

// ── DATOS QUE NECESITA EL ORQUESTADOR ────────────────

interface RemittanceRow {
  remittance_id:  string;
  sender:         string;
  amount_usdc:    string;
  clabe_hash:     string;
  mxn_amount:     string | null;
  fx_rate:        string | null;
  spei_reference: string | null;
}

interface UserRow {
  email:     string | null;
  full_name: string | null;
}

interface ContactRow {
  phone_enc: string;
}

// ── DEDUPLICACIÓN ─────────────────────────────────────
// Evita enviar la misma notificación dos veces si el worker reintenta el job.

async function alreadySent(
  remittanceId: string,
  channel: string,
  eventType: string,
): Promise<boolean> {
  const db = getDB();
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM notification_logs
    WHERE remittance_id = ${remittanceId}
      AND channel       = ${channel}
      AND event_type    = ${eventType}
      AND status        = 'sent'
    LIMIT 1
  `;
  return !!row;
}

async function logNotification(
  remittanceId: string,
  channel: string,
  recipient: string,
  eventType: string,
  status: 'sent' | 'failed',
  error?: string,
): Promise<void> {
  const db = getDB();
  await db`
    INSERT INTO notification_logs
      (remittance_id, channel, recipient, event_type, status, error)
    VALUES
      (${remittanceId}, ${channel}, ${recipient}, ${eventType}, ${status},
       ${error ?? null})
  `;
}

// Number of consecutive failures that triggers a PagerDuty alert.
const PAGERDUTY_FAILURE_THRESHOLD = 3;

async function countFailures(
  remittanceId: string,
  channel:      string,
  eventType:    string,
): Promise<number> {
  const db = getDB();
  const [row] = await db<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM notification_logs
    WHERE remittance_id = ${remittanceId}
      AND channel       = ${channel}
      AND event_type    = ${eventType}
      AND status        = 'failed'
  `;
  return row ? parseInt(row.n, 10) : 0;
}

// ── DISPATCHER PRINCIPAL ──────────────────────────────
/**
 * Llama email (Resend) + WhatsApp (Twilio) según el nuevo estado.
 * Diseñado para ser llamado desde el worker de BullMQ.
 *
 * IMPORTANTE: nunca lanza excepción — las notificaciones son fire-and-forget.
 * Un fallo de notificación NO debe abortar el procesamiento de la remesa.
 */
export async function dispatchNotifications(
  remittanceId: string,
  status: RemittanceStatus,
): Promise<void> {
  const db = getDB();

  // ── Obtener datos de la remesa ────────────────────
  let remittance: RemittanceRow | undefined;
  try {
    const [row] = await db<RemittanceRow[]>`
      SELECT remittance_id, sender, amount_usdc, clabe_hash,
             mxn_amount, fx_rate, spei_reference
      FROM remittances
      WHERE remittance_id = ${remittanceId}
    `;
    remittance = row;
  } catch (err) {
    logger.error({ err, remittanceId }, 'notifications: failed to fetch remittance');
    return;
  }

  if (!remittance) {
    logger.warn({ remittanceId }, 'notifications: remittance not found');
    return;
  }

  const amountUsdc  = Number(remittance.amount_usdc) / 1_000_000;
  const mxnAmount   = remittance.mxn_amount   ? Number(remittance.mxn_amount)  : undefined;
  const fxRate      = remittance.fx_rate      ? Number(remittance.fx_rate)     : undefined;
  const speiRef     = remittance.spei_reference ?? undefined;

  // ── Enviar EMAIL al emisor ────────────────────────
  await sendEmailNotification({
    remittanceId,
    walletAddress: remittance.sender,
    status,
    amountUsdc,
    mxnAmount,
    fxRate,
    speiRef,
  });

  // ── Enviar WHATSAPP al receptor (solo processing y delivered) ──
  // No enviamos WhatsApp en refund — el receptor no recibió nada y no
  // necesita saber que hubo un intento fallido (evitar confusión).
  if (status === 'processing' || status === 'delivered') {
    await sendWhatsAppNotification({
      remittanceId,
      clabeHash: remittance.clabe_hash,
      status,
      amountUsdc,
      mxnAmount,
      speiRef,
    });
  }
}

// ── EMAIL ─────────────────────────────────────────────

async function sendEmailNotification(params: {
  remittanceId:  string;
  walletAddress: string;
  status:        RemittanceStatus;
  amountUsdc:    number;
  mxnAmount?:    number;
  fxRate?:       number;
  speiRef?:      string;
}): Promise<void> {
  const db = getDB();
  const { remittanceId, walletAddress, status } = params;

  if (await alreadySent(remittanceId, 'email', status)) {
    logger.debug({ remittanceId, status }, 'notifications: email already sent, skipping');
    return;
  }

  let user: UserRow | undefined;
  try {
    const [row] = await db<UserRow[]>`
      SELECT email, full_name FROM users
      WHERE wallet_address = ${walletAddress.toLowerCase()}
    `;
    user = row;
  } catch (err) {
    logger.error({ err, remittanceId }, 'notifications: failed to fetch user for email');
    return;
  }

  if (!user?.email) {
    logger.debug({ remittanceId }, 'notifications: sender has no email registered, skipping');
    return;
  }

  try {
    await resendService.sendStatusEmail({
      to:            user.email,
      senderName:    user.full_name ?? '',
      remittanceId,
      amountUsdc:    params.amountUsdc,
      mxnAmount:     params.mxnAmount,
      fxRate:        params.fxRate,
      speiReference: params.speiRef,
      status,
    });

    await logNotification(remittanceId, 'email', maskEmail(user.email), status, 'sent');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, remittanceId, to: maskEmail(user.email), status },
      'notifications: email send failed',
    );
    await logNotification(
      remittanceId, 'email', maskEmail(user.email), status, 'failed', message,
    ).catch(() => {/* log insert failure is non-fatal */});

    const failures = await countFailures(remittanceId, 'email', status).catch(() => 0);
    if (failures >= PAGERDUTY_FAILURE_THRESHOLD) {
      await alertPagerDuty(
        `Email notification failed ${failures} times for remittance ${remittanceId}`,
        { remittanceId, status, channel: 'email', to: maskEmail(user.email), error: message },
      ).catch(() => {/* pagerduty alert is non-fatal */});
    }
  }
}

// ── WHATSAPP ──────────────────────────────────────────

async function sendWhatsAppNotification(params: {
  remittanceId: string;
  clabeHash:    string;
  status:       RemittanceStatus;
  amountUsdc:   number;
  mxnAmount?:   number;
  speiRef?:     string;
}): Promise<void> {
  const db = getDB();
  const { remittanceId, clabeHash, status } = params;

  if (await alreadySent(remittanceId, 'whatsapp', status)) {
    logger.debug({ remittanceId, status }, 'notifications: WhatsApp already sent, skipping');
    return;
  }

  let contact: ContactRow | undefined;
  try {
    const [row] = await db<ContactRow[]>`
      SELECT phone_enc FROM recipient_contacts
      WHERE clabe_hash = ${clabeHash}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    contact = row;
  } catch (err) {
    logger.error({ err, remittanceId }, 'notifications: failed to fetch recipient contact');
    return;
  }

  if (!contact) {
    logger.debug({ remittanceId }, 'notifications: no recipient phone registered, skipping WhatsApp');
    return;
  }

  let phone: string;
  try {
    phone = decrypt(contact.phone_enc);
  } catch (err) {
    logger.error({ err, remittanceId }, 'notifications: failed to decrypt recipient phone');
    return;
  }

  try {
    await twilioService.sendWhatsApp({
      to:            phone,
      remittanceId,
      amountUsdc:    params.amountUsdc,
      mxnAmount:     params.mxnAmount,
      speiReference: params.speiRef,
      status,
    });

    await logNotification(remittanceId, 'whatsapp', maskPhone(phone), status, 'sent');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, remittanceId, to: maskPhone(phone), status },
      'notifications: WhatsApp send failed',
    );
    await logNotification(
      remittanceId, 'whatsapp', maskPhone(phone), status, 'failed', message,
    ).catch(() => {/* log insert failure is non-fatal */});

    const failures = await countFailures(remittanceId, 'whatsapp', status).catch(() => 0);
    if (failures >= PAGERDUTY_FAILURE_THRESHOLD) {
      await alertPagerDuty(
        `WhatsApp notification failed ${failures} times for remittance ${remittanceId}`,
        { remittanceId, status, channel: 'whatsapp', to: maskPhone(phone), error: message },
      ).catch(() => {/* pagerduty alert is non-fatal */});
    }
  }
}
