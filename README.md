# novatip-backend

Node.js + Fastify backend for Novatip.

## Stack

Runtime: Node.js 20, Framework: Fastify 4, Language: TypeScript 5
Database: PostgreSQL 16 + Prisma ORM
Cache: Redis 7 + IORedis
Auth: Sign-In With Stellar (SIWS) + JWT
Email: Resend, QR: qrcode, Events: @novatip/sdk

## Local Development

Prerequisites: Node.js >= 18, Docker + Docker Compose

1. Install: npm install
2. Copy env: cp .env.example .env
3. Start infra: docker compose up -d postgres redis
4. Migrate: npm run db:generate && npm run db:migrate
5. Dev server: npm run dev  (http://localhost:3001)
6. Full stack: docker compose up -d

## Environment Variables

DATABASE_URL (required) - PostgreSQL connection string
JWT_SECRET (required) - Secret for signing JWTs
TIP_SPLITTER_CONTRACT_ID (required) - Deployed contract ID
REDIS_URL - Redis URL (default: redis://localhost:6379)
PORT - Server port (default: 3001)
STELLAR_NETWORK - testnet | mainnet | local (default: testnet)
SOROBAN_RPC_URL - Soroban RPC endpoint
HORIZON_URL - Horizon REST endpoint
NETWORK_PASSPHRASE - Stellar network passphrase
USDC_CONTRACT_ID - USDC Stellar Asset Contract ID
INDEXER_START_LEDGER - Ledger to begin indexing from (default: 0)
RESEND_API_KEY - Resend API key (skip to disable email)
APP_BASE_URL - Frontend base URL (default: http://localhost:3000)

## API Overview  (base: /api/v1)

GET  /health                 - Simple liveness ping
GET  /health/live            - Liveness (process up, no dependency checks)
GET  /health/ready           - Readiness (PostgreSQL + Redis reachable; 503 if not)

POST /auth/challenge         - Issue one-time sign-in nonce
POST /auth/verify            - Verify signature, return JWT
GET  /auth/me                - Current user (JWT)

GET    /creators/:slug       - Public creator profile
GET    /creators/check/:slug - Slug availability
POST   /creators/claim       - Claim a slug (JWT)
PATCH  /creators/me          - Update profile (JWT)
PATCH  /creators/me/splits   - Update splits (JWT)

GET /qr/:slug                - QR code SVG
GET /qr/:slug/png            - QR code PNG download
GET /resolve/:slug           - Full tip-page data

GET /analytics/totals        - Total tips, amount, supporters (JWT)
GET /analytics/timeseries    - Daily breakdown ?days=30 (JWT)
GET /analytics/top-supporters- Ranked supporters ?limit=10 (JWT)
GET /analytics/recent        - Live tip feed ?limit=20 (JWT)

GET    /webhooks             - List webhooks (JWT)
POST   /webhooks             - Register webhook (JWT)
DELETE /webhooks/:id         - Remove webhook (JWT)

## Indexer

Polls Soroban RPC every 6s for TipReceived events, persists to PostgreSQL,
dispatches webhooks, sends email notifications. Resumes from IndexerCursor.

### Cursor semantics

fetchTipEvents treats startLedger as inclusive, so after handling a batch the
loop advances to lastProcessedLedger + 1. IndexerCursor stores the last ledger
processed in full; startup resumes at cursor + 1.

A batch that comes back full (200 events) may have been cut off part-way
through its highest ledger. That ledger is held back and re-fetched on the next
poll rather than skipped — so only ledgers known to be complete are marked done.
Persisting a tip is idempotent (upsert on txHash), but webhook and email
dispatch are not, which is why the cursor must not linger on a handled ledger.

### Manual verification against testnet

1. Point .env at testnet and set INDEXER_START_LEDGER to the current ledger
   (`curl -s $SOROBAN_RPC_URL -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'`).
2. Register a webhook pointing at a request-capture endpoint, then start the
   server (`npm run dev`) and send one tip to the jar.
3. Watch the logs across the next several 6s polls. Expect exactly one
   "processing 1 event(s)" line — before the fix, every poll re-processed that
   tip until a newer one arrived.
4. Confirm the capture endpoint received exactly one delivery and the creator
   got exactly one email.
5. Check the cursor advanced past the tip's ledger:
   `SELECT "lastLedger" FROM "IndexerCursor" WHERE id = 1;`
6. Restart the server and confirm the tip is not re-delivered on resume.

## Webhook Signatures

Header: X-Novatip-Signature: sha256=<hex>
Verify: createHmac("sha256", secret).update(body).digest("hex")

## Scripts

npm run dev               - hot reload
npm run build             - compile TypeScript
npm run start             - run compiled output
npm run test              - jest
npm run typecheck         - tsc --noEmit
npm run lint              - eslint
npm run db:generate       - regenerate Prisma client
npm run db:migrate        - apply migrations (dev)
npm run db:migrate:deploy - apply migrations (production)
npm run db:studio         - open Prisma Studio

## License

MIT
