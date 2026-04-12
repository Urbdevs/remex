# remex.mx

**USDC remittances from the USA to Mexico via Base L2 + SPEI**

Sender approves USDC on Base → `RemexBridge.sendRemittance()` → backend converts via Bitso → recipient receives MXN via SPEI in under 8 minutes.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  SENDER (USA)                                                    │
│  Browser / MetaMask                                             │
│  packages/web  (Next.js 14, wagmi v2, TanStack Query)          │
└───────────────────────────┬─────────────────────────────────────┘
                            │  SIWE auth + USDC approval + sendRemittance()
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  BASE L2 (Base Sepolia testnet / Base mainnet)                  │
│  RemexBridge.sol (Ownable2Step, Pausable, ReentrancyGuard)      │
│  packages/contracts                                             │
│                                                                 │
│  sendRemittance(amount, clabeHash, recipientHash)               │
│    → deducts 1.4% fee → forwards fee to treasury               │
│    → emits RemittanceSent event                                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │  watchContractEvent (viem)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKEND API (Fastify, Node 20)                                 │
│  packages/api  — localhost:3001                                 │
│                                                                 │
│  bridgeListener → BullMQ queue → remittanceWorker              │
│    1. Calls Bitso Business API (USDC → MXN)                    │
│    2. Triggers SPEI payout to recipient CLABE                  │
│    3. Calls confirmDelivery() on-chain                          │
│    4. Sends email (Resend) + WhatsApp (Twilio)                 │
│                                                                 │
│  Routes:                                                        │
│    GET  /health                                                 │
│    POST /v1/auth/nonce  /v1/auth/verify  GET /v1/auth/me       │
│    GET  /v1/kyc  POST /v1/kyc/webhook                          │
│    GET  /v1/transfers  POST /v1/transfers/recipient-info        │
│    POST /v1/transfers/check-limit                               │
│    GET  /v1/admin/metrics  /v1/admin/remittances                │
└──────────┬────────────────────────────┬────────────────────────┘
           │                            │
           ▼                            ▼
┌──────────────────┐         ┌──────────────────────┐
│  PostgreSQL 15   │         │  Redis 7             │
│  remittances     │         │  BullMQ queues       │
│  users           │         │  SIWE nonces (60s)   │
│  recipient_cont. │         │                      │
│  notification_l. │         └──────────────────────┘
└──────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│  RECIPIENT (Mexico)                                          │
│  Receives MXN via SPEI to their bank account (CLABE)        │
│  WhatsApp notification from Twilio                           │
└──────────────────────────────────────────────────────────────┘
```

---

## Monorepo Structure

```
remex/
├── packages/
│   ├── api/          Fastify REST API + BullMQ workers
│   ├── contracts/    RemexBridge.sol (Hardhat + Ethers v6)
│   └── web/          Next.js 14 App Router frontend
├── packages/docker-compose.yml   PostgreSQL + Redis for local dev
└── README.md
```

---

## Quick Start — Local Development

### Prerequisites

- Node.js 20+
- Docker Desktop (for PostgreSQL + Redis)
- MetaMask browser extension

### 1. Start infrastructure

```bash
cd packages
docker compose up -d
# PostgreSQL → localhost:5432  (user: remex, password: remex_dev_password, db: remex)
# Redis      → localhost:6379
```

### 2. Set up the API

```bash
cd packages/api
cp .env.example .env
# Edit .env with your values (see Environment Variables section below)

npm install
npm run db:migrate      # create tables
npm run dev             # → http://localhost:3001
```

### 3. Set up the frontend

```bash
cd packages/web
cp .env.local.example .env.local
# Edit .env.local (set NEXT_PUBLIC_CONTRACT_ADDRESS after deploy)

npm install
npm run dev             # → http://localhost:3000
```

### 4. Compile + test contracts

```bash
cd packages/contracts
npm install
npm run compile
npm test
```

---

## Deploy to Base Sepolia (Testnet)

### Step 1 — Set contract environment variables

```bash
cd packages/contracts
cp .env.example .env
```

Edit `packages/contracts/.env`:

```env
DEPLOYER_PRIVATE_KEY=0x...    # Wallet with Base Sepolia ETH
TREASURY_ADDRESS=0x...        # Receives protocol fees (can be deployer for testnet)
RELAYER_ADDRESS=0x...         # Backend hot wallet (from packages/api .env RELAYER_PRIVATE_KEY)
BASESCAN_API_KEY=...          # From https://basescan.org/myapikey
GNOSIS_SAFE_ADDRESS=0x...     # Optional: transfer ownership post-deploy
```

Get Base Sepolia ETH: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet

### Step 2 — Deploy

```bash
cd packages/contracts
npm run deploy:testnet
```

Output includes the deployed contract address and Basescan link. Copy `CONTRACT_ADDRESS`.

### Step 3 — Update API and frontend

In `packages/api/.env`:
```env
CONTRACT_ADDRESS=0x<deployed-address>
```

In `packages/web/.env.local`:
```env
NEXT_PUBLIC_CONTRACT_ADDRESS=0x<deployed-address>
```

### Step 4 — Verify the deployment

```bash
cd packages/contracts
npx hardhat run scripts/verify.ts --network baseSepolia
```

Expected output: all checks pass, relayer authorized, limits correct.

### Step 5 — Run smoke test

Get Base Sepolia USDC from https://faucet.circle.com, then:

```bash
npx hardhat run scripts/smokeTest.ts --network baseSepolia
```

Expected output: `RemittanceSent` event emitted, remittance in `Pending` status.

### Step 6 — Verify on Basescan

https://sepolia.basescan.org/address/`<CONTRACT_ADDRESS>`

---

## Deploy to Base Mainnet

> **WARNING**: Mainnet deploy is irreversible and handles real funds.
> Complete the full testnet cycle first.

```bash
# All env vars required for mainnet (no defaults)
DEPLOYER_PRIVATE_KEY=0x...
TREASURY_ADDRESS=0x...
RELAYER_ADDRESS=0x...
GNOSIS_SAFE_ADDRESS=0x...    # Required for mainnet — transfer ownership to Safe
BASESCAN_API_KEY=...

cd packages/contracts
npm run deploy:mainnet

# After deploy: Gnosis Safe must call acceptOwnership() to finalize 2-step transfer
```

---

## Environment Variables

### `packages/api/.env`

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | API port (default: 3001) |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_HOST` | yes | Redis host (default: localhost) |
| `REDIS_PORT` | yes | Redis port (default: 6379) |
| `CONTRACT_ADDRESS` | yes | Deployed RemexBridge address |
| `BASE_SEPOLIA_RPC` | no | Base Sepolia RPC (default: public) |
| `BASE_MAINNET_RPC` | no | Base Mainnet RPC (default: public) |
| `NETWORK` | no | `testnet` or `mainnet` (default: testnet) |
| `RELAYER_PRIVATE_KEY` | yes | Backend hot wallet private key |
| `JWT_SECRET` | yes | Min 32 chars — `openssl rand -hex 32` |
| `ADMIN_API_KEY` | yes | Min 32 chars — `openssl rand -hex 32` |
| `BITSO_API_KEY` | yes | From https://bitso.com/business |
| `BITSO_API_SECRET` | yes | From https://bitso.com/business |
| `PERSONA_API_KEY` | yes | From https://withpersona.com/dashboard |
| `PERSONA_TEMPLATE_ID` | yes | Government ID + Selfie template ID |
| `PERSONA_WEBHOOK_SECRET` | yes | Webhook signing secret from Persona |
| `RESEND_API_KEY` | yes | From https://resend.com/api-keys |
| `RESEND_FROM` | yes | Verified sender email |
| `TWILIO_ACCOUNT_SID` | yes | From https://console.twilio.com |
| `TWILIO_AUTH_TOKEN` | yes | From https://console.twilio.com |
| `TWILIO_WHATSAPP_FROM` | yes | `whatsapp:+14155238886` (sandbox) |
| `NOTIFICATION_ENCRYPTION_KEY` | yes | 64 hex chars — `openssl rand -hex 32` |
| `PAGERDUTY_ROUTING_KEY` | no | Events API v2 routing key |
| `FRONTEND_URL` | no | CORS origin (default: http://localhost:3000) |

### `packages/web/.env.local`

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | yes | API base URL |
| `NEXT_PUBLIC_NETWORK` | yes | `testnet` or `mainnet` |
| `NEXT_PUBLIC_CONTRACT_ADDRESS` | yes | Deployed RemexBridge address |
| `NEXT_PUBLIC_USDC_ADDRESS` | yes | USDC token address on Base |
| `NEXT_PUBLIC_BASE_RPC_URL` | no | Base RPC URL |
| `NEXT_PUBLIC_BASESCAN_URL` | no | Block explorer base URL |
| `NEXT_PUBLIC_PERSONA_TEMPLATE_ID` | yes | From Persona dashboard |
| `NEXT_PUBLIC_PERSONA_ENV` | yes | `sandbox` or `production` |

### `packages/contracts/.env`

| Variable | Required | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | yes (deploy) | Wallet private key for deployment |
| `TREASURY_ADDRESS` | yes (mainnet) | Protocol fee recipient |
| `RELAYER_ADDRESS` | yes (mainnet) | Authorized backend wallet |
| `GNOSIS_SAFE_ADDRESS` | yes (mainnet) | Safe that will own the contract |
| `BASESCAN_API_KEY` | yes (verify) | For Basescan verification |
| `BASE_SEPOLIA_RPC` | no | Custom RPC (default: public) |
| `BASE_MAINNET_RPC` | no | Custom RPC (default: public) |

---

## NPM Scripts Reference

### API (`packages/api`)

```bash
npm run dev          # Start with hot-reload (tsx watch)
npm run build        # Compile TypeScript
npm start            # Run compiled output
npm test             # Run Vitest test suite (150 tests)
npm run db:migrate   # Apply schema migrations
```

### Contracts (`packages/contracts`)

```bash
npm run compile              # Compile Solidity + generate typechain types
npm test                     # Run Hardhat tests
npm run test:coverage        # Coverage report
npm run deploy:testnet       # Deploy to Base Sepolia
npm run deploy:mainnet       # Deploy to Base Mainnet (caution)

# Post-deploy scripts (run with --network baseSepolia|base)
npx hardhat run scripts/verify.ts --network baseSepolia
npx hardhat run scripts/smokeTest.ts --network baseSepolia
```

### Frontend (`packages/web`)

```bash
npm run dev    # Development server → http://localhost:3000
npm run build  # Production build (0 TS errors required)
npm start      # Serve production build
```

---

## Contract: RemexBridge

**Network addresses**

| Network | Address |
|---|---|
| Base Sepolia | set post-deploy in `.env` |
| Base Mainnet | set post-deploy in `.env` |

**Key parameters**

| Parameter | Value |
|---|---|
| Fee | 140 bps = 1.4% |
| Min transaction | $10 USDC |
| Max transaction | $2,999 USDC (FinCEN CTR threshold) |
| Daily limit | $5,000 USDC per sender |
| USDC decimals | 6 |

**Core flow**

```
User approves USDC → sendRemittance(amount, clabeHash, recipientHash)
  → fee forwarded to treasury immediately
  → net amount held in contract pending off-ramp
  → RemittanceSent event emitted

Backend picks up event → Bitso API (USDC → MXN) → SPEI payout
  → confirmDelivery(id, speiRef, mxnAmount)
  → RemittanceDelivered event emitted
```

---

## KYC / Compliance (FinCEN MSB)

Remex operates as a Money Services Business under FinCEN regulations.

| Tier | KYC | Daily Limit |
|---|---|---|
| Unverified | None | $500 |
| Standard | Government ID + Selfie | $3,000 |
| Enhanced | Enhanced due diligence | $10,000 |

KYC is handled by [Persona](https://withpersona.com). Webhooks are verified with HMAC-SHA256 (`PERSONA_WEBHOOK_SECRET` required — no environment bypass).

---

## Security

Key security properties:

- **SIWE (EIP-4361)**: Sign-In with Ethereum. Nonces are single-use, atomic Redis `GETDEL`, valid for 60s. `Issued At` must be ≤5 minutes old.
- **Ownable2Step**: Contract ownership transfer requires explicit `acceptOwnership()` — prevents accidental loss of control.
- **ReentrancyGuard**: All USDC transfer paths protected.
- **Rate limiting**: Global 100 req/min, POST `/v1/auth/verify` 10 req/min.
- **FinCEN CTR**: Max tx capped at $2,999 USDC to stay below Currency Transaction Report threshold.
- **CLABE privacy**: Raw CLABE numbers never stored on-chain — only `keccak256(clabe)`.
- **PagerDuty alerts**: Notification failures after 3 attempts escalate automatically.

See `docs/SECURITY_REPORT.md` and `docs/STRIDE.md` for full threat model.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity 0.8.24, OpenZeppelin 5, Hardhat 2 |
| Blockchain | Base L2 (OP Stack, Ethereum L2) |
| Token | USDC (Circle, ERC-20, 6 decimals) |
| Backend | Fastify 4, Node 20, TypeScript 5 |
| Queue | BullMQ + Redis 7 |
| Database | PostgreSQL 15, `postgres` npm driver |
| Frontend | Next.js 14 App Router, React 18 |
| Wallet | wagmi v2 + viem v2, MetaMask |
| State | TanStack Query v5 |
| Styling | Tailwind CSS 3.4, Inter + IBM Plex Mono |
| KYC | Persona.com (Government ID + Selfie) |
| Off-ramp | Bitso Business API (USDC → MXN + SPEI) |
| Email | Resend |
| WhatsApp | Twilio |
| Monitoring | PagerDuty Events API v2 |
| Auth | SIWE (EIP-4361) + JWT (HS256) |
