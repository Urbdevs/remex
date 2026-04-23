-- ─────────────────────────────────────────────────────
-- remex.mx — Schema PostgreSQL
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS remittances (
  id             BIGSERIAL PRIMARY KEY,
  remittance_id  TEXT        NOT NULL UNIQUE,  -- ID del contrato on-chain
  sender         TEXT        NOT NULL,          -- Wallet address del emisor
  amount_usdc    TEXT        NOT NULL,          -- Monto USDC (6 decimales, como string)
  fee_usdc       TEXT        NOT NULL,          -- Fee cobrado
  clabe_hash     TEXT        NOT NULL,          -- keccak256 del CLABE
  recipient_hash TEXT        NOT NULL,          -- keccak256 del nombre
  tx_hash        TEXT        NOT NULL,          -- Hash de tx en Base L2
  block_number   TEXT        NOT NULL,          -- Bloque donde se emitió el evento
  status         TEXT        NOT NULL DEFAULT 'pending',  -- pending|processing|delivered|refunded
  fx_rate        NUMERIC(12,4),                 -- Tipo de cambio USD/MXN usado
  mxn_amount     NUMERIC(12,2),                 -- MXN depositados al receptor
  spei_reference TEXT,                          -- Referencia Banxico/SPEI
  error_message  TEXT,                          -- Mensaje de error si falló
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,                   -- Cuando se entregó o reembolsó
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para queries frecuentes
CREATE INDEX IF NOT EXISTS idx_remittances_sender
  ON remittances (sender);

CREATE INDEX IF NOT EXISTS idx_remittances_status
  ON remittances (status);

CREATE INDEX IF NOT EXISTS idx_remittances_created_at
  ON remittances (created_at DESC);

-- Auto-actualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER remittances_updated_at
  BEFORE UPDATE ON remittances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────
-- USERS — Identidad verificada (FinCEN MSB compliance)
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL    PRIMARY KEY,
  wallet_address      TEXT         NOT NULL UNIQUE,  -- Ethereum address lowercase
  email               TEXT,
  kyc_status          TEXT         NOT NULL DEFAULT 'none',
  -- none | pending | submitted | approved | declined | under_review
  persona_inquiry_id  TEXT,                          -- Persona.com inquiry ID
  kyc_approved_at     TIMESTAMPTZ,
  full_name           TEXT,                          -- Populated post-KYC approval
  -- FinCEN transaction tier based on KYC level
  transaction_tier    TEXT         NOT NULL DEFAULT 'unverified',
  -- unverified (<$500/day) | standard (<$3k/day) | enhanced (<$10k/day)
  daily_sent_usd      NUMERIC(12,2) NOT NULL DEFAULT 0,  -- Acumulado del día (reset diario)
  daily_reset_at      DATE,                          -- Fecha del último reset
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_wallet
  ON users (wallet_address);

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────
-- KYC_EVENTS — Audit trail inmutable (FinCEN BSA)
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kyc_events (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     BIGINT       NOT NULL REFERENCES users(id),
  event_type  TEXT         NOT NULL,
  -- inquiry_created | submitted | approved | declined |
  -- under_review | webhook_received | ctr_filed | sar_filed
  inquiry_id  TEXT,
  payload     JSONB,                                 -- Raw Persona webhook payload
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()    -- Immutable — sin updated_at
);

CREATE INDEX IF NOT EXISTS idx_kyc_events_user
  ON kyc_events (user_id, created_at DESC);

-- ─────────────────────────────────────────────────────
-- Vincular remittances con users (FK opcional para migración)
-- ─────────────────────────────────────────────────────

ALTER TABLE remittances
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_remittances_user
  ON remittances (user_id);

-- ─────────────────────────────────────────────────────
-- RECIPIENT_CONTACTS — Teléfonos cifrados para WhatsApp
-- ─────────────────────────────────────────────────────
-- El frontend calcula keccak256(CLABE) antes del tx on-chain y
-- llama POST /v1/transfers/recipient-info para guardar el teléfono.
-- El backend cifra con AES-256-GCM antes de persistir.

CREATE TABLE IF NOT EXISTS recipient_contacts (
  id            BIGSERIAL    PRIMARY KEY,
  clabe_hash    TEXT         NOT NULL,        -- keccak256(CLABE) — coincide con on-chain
  phone_enc     TEXT         NOT NULL,        -- AES-256-GCM: iv:tag:ciphertext (hex)
  registered_by BIGINT       REFERENCES users(id),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Un usuario registra un teléfono por CLABE como máximo
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipient_contacts_clabe_user
  ON recipient_contacts (clabe_hash, registered_by);

-- ─────────────────────────────────────────────────────
-- NOTIFICATION_LOGS — Audit trail de notificaciones
-- ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_logs (
  id            BIGSERIAL    PRIMARY KEY,
  remittance_id TEXT         NOT NULL,
  channel       TEXT         NOT NULL,  -- email | whatsapp
  recipient     TEXT         NOT NULL,  -- email o teléfono enmascarado
  event_type    TEXT         NOT NULL,  -- processing | delivered | refunded
  status        TEXT         NOT NULL,  -- sent | failed
  error         TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_remittance
  ON notification_logs (remittance_id, created_at DESC);