import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDB } from '../db/client';
import { personaService, PersonaWebhookEvent } from '../services/persona';
import { logger } from '../services/logger';

// ── UMBRALES FINCEN MSB ───────────────────────────────
// 31 CFR § 1022.310 — MSB debe reportar transacciones > $10,000 (CTR)
// 31 CFR § 1022.320 — Suspicious Activity Report (SAR) ante indicios
// 31 CFR § 1022.410 — Record-keeping para transacciones > $3,000
const TIER_MAP: Record<string, string> = {
  approved:     'standard',   // KYC básico → hasta $3,000/día
  // KYC enhanced (configurable via Persona template) → hasta $10,000/día
};

// ── ROUTES ────────────────────────────────────────────

export async function kycRoutes(server: FastifyInstance) {
  const db = getDB();

  // ── POST /v1/kyc/start ────────────────────────
  // Crea un inquiry Persona y devuelve el session token al frontend.
  // El frontend usa el Persona Embedded SDK con ese token.
  server.post(
    '/start',
    { preHandler: [server.authenticate] },
    async (request, reply) => {
      const { sub, wallet, kyc } = request.user;

      // No re-iniciar si ya está aprobado
      if (kyc === 'approved') {
        return reply.status(400).send({
          error:   'KYC_ALREADY_APPROVED',
          message: 'Your identity is already verified',
        });
      }

      // Verificar si ya tiene un inquiry activo en DB
      const [existing] = await db<{ persona_inquiry_id: string | null; kyc_status: string }[]>`
        SELECT persona_inquiry_id, kyc_status FROM users WHERE id = ${sub}
      `;

      if (existing?.persona_inquiry_id && existing.kyc_status === 'submitted') {
        return reply.status(400).send({
          error:   'KYC_UNDER_REVIEW',
          message: 'Your verification is being reviewed',
          inquiryId: existing.persona_inquiry_id,
        });
      }

      // Crear nuevo inquiry en Persona
      const inquiry = await personaService.createInquiry(wallet);

      // Registrar en DB y auditar
      await db`
        UPDATE users
        SET persona_inquiry_id = ${inquiry.inquiryId},
            kyc_status = 'pending'
        WHERE id = ${sub}
      `;

      await db`
        INSERT INTO kyc_events (user_id, event_type, inquiry_id, payload)
        VALUES (${sub}, 'inquiry_created', ${inquiry.inquiryId}, ${JSON.stringify({ wallet })})
      `;

      logger.info({ userId: sub, inquiryId: inquiry.inquiryId }, 'KYC inquiry created');

      return reply.send({
        inquiryId:    inquiry.inquiryId,
        sessionToken: inquiry.sessionToken,
        status:       inquiry.status,
      });
    },
  );

  // ── GET /v1/kyc/status ────────────────────────
  // Estado actual del KYC del usuario autenticado.
  server.get(
    '/status',
    { preHandler: [server.authenticate] },
    async (request, reply) => {
      const { sub } = request.user;

      const [user] = await db<{
        kyc_status:         string;
        transaction_tier:   string;
        persona_inquiry_id: string | null;
        kyc_approved_at:    string | null;
      }[]>`
        SELECT kyc_status, transaction_tier, persona_inquiry_id, kyc_approved_at
        FROM users WHERE id = ${sub}
      `;

      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send({ data: user });
    },
  );

  // ── POST /v1/kyc/webhook ──────────────────────
  // Persona.com llama este endpoint cuando cambia el estado de un inquiry.
  // SEGURIDAD: Verificamos la firma HMAC antes de procesar.
  // FINCEN: Este handler actualiza el tier de transacciones y audita el evento.
  server.post(
    '/webhook',
    {
      config: { rawBody: true },  // Necesitamos el body crudo para verificar firma
    },
    async (request: FastifyRequest, reply) => {
      const signatureHeader = request.headers['persona-signature'] as string;

      if (!signatureHeader) {
        logger.warn('Persona webhook received without signature header');
        return reply.status(400).send({ error: 'Missing signature' });
      }

      // Obtener raw body (Fastify lo expone en request.rawBody si se configuró)
      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody
        ?? JSON.stringify(request.body);

      const valid = personaService.verifyWebhookSignature(rawBody, signatureHeader);
      if (!valid) {
        logger.error({ signatureHeader }, 'Invalid Persona webhook signature — rejecting');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      const event = request.body as PersonaWebhookEvent;
      const eventType = event.data.type;
      const inquiryId = event.data.relationships?.inquiry?.data?.id ?? event.data.id;

      logger.info({ eventType, inquiryId }, 'Persona webhook received');

      // Buscar usuario por inquiry ID
      const [user] = await db<{ id: string; kyc_status: string }[]>`
        SELECT id, kyc_status FROM users
        WHERE persona_inquiry_id = ${inquiryId}
      `;

      if (!user) {
        // Puede ser un inquiry de prueba o de otro entorno — loguear y 200
        logger.warn({ inquiryId }, 'Persona webhook: no user found for inquiry');
        return reply.status(200).send({ received: true });
      }

      // Auditar el evento SIEMPRE (antes de procesar — FinCEN requires audit trail)
      await db`
        INSERT INTO kyc_events (user_id, event_type, inquiry_id, payload)
        VALUES (
          ${user.id},
          'webhook_received',
          ${inquiryId},
          ${JSON.stringify({ eventType, attributes: event.data.attributes })}
        )
      `;

      // Mapear estado Persona → estado interno
      const newStatus = personaService.mapStatus(
        event.data.attributes.status ?? eventType.replace('inquiry.', ''),
      );

      // Solo actualizar si hay cambio de estado relevante
      if (newStatus !== user.kyc_status) {
        const newTier = TIER_MAP[newStatus] ?? user.kyc_status === 'approved'
          ? 'standard'
          : 'unverified';

        const fullName = personaService.extractNameFromWebhook(event);

        await db`
          UPDATE users
          SET kyc_status       = ${newStatus},
              transaction_tier = ${newTier},
              ${fullName ? db`full_name = ${fullName},` : db``}
              ${newStatus === 'approved' ? db`kyc_approved_at = NOW(),` : db``}
              updated_at = NOW()
          WHERE id = ${user.id}
        `;

        // Auditar el cambio de estado (evento separado para audit trail)
        await db`
          INSERT INTO kyc_events (user_id, event_type, inquiry_id, payload)
          VALUES (
            ${user.id},
            ${newStatus === 'approved' ? 'approved'
              : newStatus === 'declined' ? 'declined'
              : newStatus === 'submitted' ? 'submitted'
              : 'under_review'},
            ${inquiryId},
            ${JSON.stringify({ previousStatus: user.kyc_status, newStatus, newTier })}
          )
        `;

        logger.info(
          { userId: user.id, inquiryId, previousStatus: user.kyc_status, newStatus },
          'KYC status updated from webhook',
        );
      }

      // Persona espera 200 para no reintentar
      return reply.status(200).send({ received: true });
    },
  );
}
