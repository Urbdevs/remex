# STRIDE Threat Model — remex.mx API

**Date:** 2026-04-12  
**Scope:** 4 critical components — RemexBridge.sol, SIWE Auth Flow, Bitso Off-ramp, Persona KYC Webhook  
**Methodology:** STRIDE (Spoofing / Tampering / Repudiation / Information Disclosure / DoS / Elevation of Privilege)

---

## 1. RemexBridge.sol

The on-chain bridge contract that accepts USDC deposits and emits `RemittanceSent` events that trigger the off-ramp pipeline.

**Security controls in place:** `ReentrancyGuard`, `Pausable`, `Ownable2Step`, `SafeERC20`, `onlyRelayer` modifier, minimum fee enforcement.

| # | Threat | STRIDE | Severity | Status | Mitigation |
|---|--------|--------|----------|--------|------------|
| R1 | Miner manipulates `block.timestamp` ±900s to reset daily volume early | Tampering | Low | Accepted | Daily volume window ±15min drift is acceptable; contract comment documents this |
| R2 | Attacker front-runs `sendRemittance` to steal fee refund on revert | Tampering | Low | Mitigated | `nonReentrant` guard prevents re-entrancy; fee is transferred atomically with USDC via `SafeERC20` |
| R3 | Relayer private key compromised — attacker can update any remittance status | Elevation of Privilege | Critical | Accepted (operational) | Hot wallet with minimal balance; rotation SOP required; consider MPC/HSM in production |
| R4 | DoS via spam `sendRemittance` to fill BullMQ queue | DoS | Medium | Mitigated | Minimum fee (100 USDC) makes spam expensive; `Pausable` emergency stop; `/v1/admin/queue` monitors queue depth |
| R5 | Owner account compromised — attacker can transfer ownership or pause | Elevation of Privilege | High | Mitigated | `Ownable2Step` requires two-step handshake; owner key should be cold wallet or multisig |
| R6 | Reentrancy on ERC-20 callback during `sendRemittance` | Tampering | High | Mitigated | `nonReentrant` modifier on `sendRemittance`; USDC uses no callbacks (no ERC-777) |
| R7 | Repudiation of `RemittanceSent` event | Repudiation | Low | Mitigated | All events indexed on-chain with `remittanceId`, `clabeHash`, `timestamp` — immutable audit trail |

---

## 2. SIWE Auth Flow

**Flow:** `GET /nonce` → Redis TTL 300s → Client signs EIP-4361 message → `POST /verify` → JWT issued.

**Security controls in place:** ioredis `GETDEL` (atomic), nonce regex `{32}`, issuedAt ≤5min check, `viem.verifyMessage()`, HS256 JWT (8h), `@fastify/rate-limit`.

| # | Threat | STRIDE | Severity | Status | Mitigation |
|---|--------|--------|----------|--------|------------|
| S1 | Nonce replay: two concurrent requests with same nonce both succeed (TOCTOU) | Spoofing | High | **Fixed** | `redis.GETDEL` is atomic — only one caller gets the stored value |
| S2 | Stale message replay: valid old signature used after nonce expires | Spoofing | Medium | **Fixed** | `Issued At` validated ≤5 min at `POST /verify` (checked before nonce consumption) |
| S3 | Nonce stuffing: malformed nonce length bypasses validation | Tampering | Medium | **Fixed** | Regex enforces exactly 32 hex chars matching `crypto.randomBytes(16).toString('hex')` |
| S4 | Brute-force valid wallet addresses at `/verify` | DoS / Spoofing | Medium | **Fixed** | `@fastify/rate-limit`: 10 req/min on `POST /verify`, 100 req/min global |
| S5 | Weak JWT secret allows offline token forgery | Information Disclosure | Critical | Mitigated | `authPlugin` rejects `JWT_SECRET` < 32 chars with startup error; `.env.example` documents `openssl rand -hex 32` |
| S6 | JWT not invalidated on logout (no blacklist) | Spoofing | Low | Accepted | 8h TTL acceptable for current threat model; stateless design priority; blacklist is a future enhancement |
| S7 | viem.verifyMessage accepts EIP-1271 contract signatures (smart wallet) | Spoofing | Low | Accepted | Smart wallet signatures are valid SIWE; no business reason to reject them |

---

## 3. Bitso Off-ramp Integration

**Flow:** Worker fetches FX quote → places SPEI payout order → polls for confirmation → updates DB.

**Security controls in place:** HMAC-SHA256 signed requests, credentials in env vars, HTTPS, retry with exponential backoff (3×).

| # | Threat | STRIDE | Severity | Status | Mitigation |
|---|--------|--------|----------|--------|------------|
| B1 | BITSO_API_SECRET compromised — attacker can initiate fraudulent SPEI payouts | Spoofing | Critical | Accepted (operational) | Secret in env var, never logged; rotation procedure required; no scoped API key support from Bitso |
| B2 | Man-in-the-middle on Bitso API response → tampered FX rate or SPEI reference | Tampering | Medium | Mitigated | TLS to `api.bitso.com`; certificate pinning not feasible (SaaS); response validated for required fields |
| B3 | FX rate slippage between quote and execution | Tampering | Low | Accepted | Quote fetched fresh per transaction; worker uses Bitso's returned rate (auditable in DB as `fx_rate`) |
| B4 | Bitso API outage leaves remittance in `processing` indefinitely | DoS | Medium | Mitigated | 3 retries with exponential backoff; `/v1/admin/stuck` alerts after configurable threshold (default 15min) |
| B5 | Worker logs HMAC nonce but leaks credentials in error messages | Information Disclosure | Medium | Mitigated | Error logging in `remittanceQueue.ts` logs error message only; credentials never interpolated in log calls |
| B6 | Duplicate SPEI payout on worker retry | Tampering | High | Mitigated | Worker checks `remittance.status === 'processing'` before placing order; idempotent by `remittance_id` |

---

## 4. Persona.com KYC Webhook

**Flow:** Persona sends `POST /v1/kyc/webhook` → HMAC-SHA256 signature verified → KYC status updated in DB → tier promoted.

**Security controls in place:** `HMAC-SHA256` with `crypto.timingSafeEqual`, signature read at call time (not constructor), no bypass in production.

| # | Threat | STRIDE | Severity | Status | Mitigation |
|---|--------|--------|----------|--------|------------|
| P1 | Forged webhook promotes user KYC tier without real verification | Elevation of Privilege | Critical | Mitigated (prod) / **Medium risk** (dev/staging) | Signature verified with `timingSafeEqual`; but if `PERSONA_WEBHOOK_SECRET` unset → verification skipped in non-prod |
| P2 | Webhook replay: valid webhook re-sent to process same inquiry twice | Repudiation | Low | Partially mitigated | `ON CONFLICT DO UPDATE` is idempotent for `kyc_events`; `kyc_status` transitions are logged; no `delivered_at` dedup yet |
| P3 | Webhook secret logged accidentally | Information Disclosure | Low | Mitigated | Secret only used in `timingSafeEqual` call; no log interpolation of secret value confirmed in code review |
| P4 | Persona sends `inquiry.declined` but webhook is delayed → user already sent funds | Information Disclosure | Low | Accepted | `requireKYC` checks JWT `kyc` field which is refreshed on login; declined users lose access on next auth |
| P5 | DoS via spam webhook calls to `/v1/kyc/webhook` | DoS | Low | Accepted | No rate limit on webhook endpoint; Persona is the only caller; IP allowlist is a future enhancement |

---

## Summary Risk Matrix

| Severity | Count | Components |
|----------|-------|------------|
| Critical | 2 | Relayer key (R3), JWT secret (S5) — both operational/configuration risks |
| High | 2 | Owner key (R5), reentrancy (R6 — mitigated) |
| Medium | 5 | Queue DoS (R4), brute-force (S4), stale replay (S2), MITM Bitso (B3), Persona bypass non-prod (P1) |
| Low | 8 | Remainder — accepted or low-impact |

---

## Recommendations

1. **Relayer key**: Use MPC wallet (e.g., Fireblocks) or HSM in production. Rotate every 90 days.
2. **Owner key**: Move to Gnosis Safe 2/3 multisig before mainnet launch.
3. **Persona webhook in staging**: Require `PERSONA_WEBHOOK_SECRET` to be set even in staging. Remove the `NODE_ENV !== 'production'` bypass.
4. **Webhook replay deduplication**: Store processed `webhook_id` from Persona headers in a Redis set with 24h TTL.
5. **Bitso key scoping**: Request Bitso to support scoped API keys (SPEI-only) to limit blast radius of credential compromise.
