# novatip-backend

Node.js + Fastify backend for Novatip.

## Stack

Runtime: Node.js 20, Framework: Fastify 4, Language: TypeScript 5
Database: PostgreSQL 16 + Prisma ORM
Cache: Redis 7 + IORedis (Redis 6.2+ required for atomic `GETDEL` nonce consumption)
Auth: Sign-In With Stellar (SIWS) + JWT
Email: Resend, QR: qrcode, Events: @novatip/sdk

## Local Development

Prerequisites: Node.js >= 20, Docker + Docker Compose

1. Install: npm install
2. Copy env: cp .env.example .env
3. Start infra: docker compose up -d postgres redis
4. Migrate: npm run db:generate && npm run db:migrate
5. Dev server: npm run dev (http://localhost:3001)
6. Full stack: docker compose up -d

### Run against a freshly deployed testnet contract

The contract repository's published testnet deployment may not match the
current contract interface. To exercise indexing against the current code,
deploy a fresh testnet contract from
[Novatip/novatip-contracts](https://github.com/Novatip/novatip-contracts):

1. Install Stellar CLI 27.1.0 or newer and Rust, then clone the contracts
   repository. From its root, install the Wasm target with
   `rustup target add wasm32v1-none`.
2. Generate and fund a testnet Stellar identity, then copy `.env.example` to
   `.env` in the contracts repository. Set `NETWORK=testnet`, `SOURCE` to the
   identity name, `ADMIN` to the admin address, and `USDC_TOKEN` to the testnet
   USDC contract listed in that repository's README.
3. Run `make deploy`. This builds and deploys the contract and writes its ID
   to `.contract-id.testnet`. If the deploy script rejects the documented
   testnet USDC ID, verify the ID against the contracts README and rerun with
   `ALLOW_CUSTOM_TOKEN=1 make deploy`; this bypasses the script's token-ID
   guard but still deploys with the `USDC_TOKEN` value you set.
4. In this repository's `.env`, set `STELLAR_NETWORK=testnet`,
   `SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`,
   `NETWORK_PASSPHRASE="Test SDF Network ; September 2015"`,
   `USDC_CONTRACT_ID` to the same testnet USDC contract, and
   `TIP_SPLITTER_CONTRACT_ID` to the ID printed by `make deploy`. Set
   `INDEXER_START_LEDGER` to the deployment ledger if known. Otherwise, use a
   recent ledger shortly before starting the backend (for example, the
   current testnet ledger minus 1,000), not `0`; a fresh deployment has no
   useful history to scan from genesis.
5. Use the contracts repository's `scripts/create-jar.sh` to create a jar
   whose `SLUG` matches the backend's on-chain `jarId` (claiming `alice` in the
   backend derives `@alice`). Register/claim that creator in the backend for
   the same wallet, then use `scripts/tip.sh` in the contracts repository to
   send a test tip to that jar. Ensure the sender and jar recipients have the
   required testnet USDC trustlines.
6. Start this backend with `npm run dev`. Confirm its indexer logs the event
   and that the tip appears in the database or analytics for the registered
   creator.

## Data Model

The PostgreSQL schema is defined in `prisma/schema.prisma`. Its seven models
connect creator accounts to indexed tips, their notification and webhook
delivery paths, and the slugs they have released:

- **Creator** represents a tip recipient. Its wallet address, public slug, and
  on-chain `jarId` are unique. A creator has many tips, webhooks,
  notifications, and released slugs. Its optional notification email is
  tracked separately from `emailVerifiedAt`, which is set only after the
  creator confirms the address.
  `jarId` is unique because each on-chain jar must resolve to
  exactly one creator; the slug and wallet address likewise identify a single
  public profile and account.
- **ReleasedSlug** records a slug a creator gave up by renaming or claiming a
  different one, and when. Until `CREATOR_SLUG_HOLD_DAYS` (default 90) have
  passed, the slug stays unavailable to everyone but its previous owner, so old
  tip links and QR codes can't be taken over by whoever claims it next. The
  slug itself is the primary key, so there is one row per slug (its latest
  release). Each row optionally belongs to one creator; `previousOwnerId` is
  set to null if that creator is deleted, and the slug is then held with no
  exempt owner.
- **Tip** stores an indexed on-chain tip, including its transaction hash,
  ledger, sender, amount, and optional message. Each tip belongs to one creator.
  `txHash` is unique so the indexer can deduplicate events and avoid recording
  the same transaction more than once. `amount` is stored as a string in USDC
  stroops rather than a numeric type because the contract uses 128-bit integer
  amounts, which can exceed the exact precision of JavaScript numbers. Keeping
  it as a string preserves the full amount without a lossy numeric conversion.
- **Webhook** stores a creator's target URL, HMAC signing secret, and enabled
  state. It belongs to one creator and has many delivery-attempt records.
- **WebhookDelivery** records an individual attempt to send a webhook,
  including its payload, response status, success state, and attempt time. Each
  delivery belongs to one webhook.
- **Notification** stores a creator-facing event and its JSON payload, such as
  a received tip or failed webhook. It belongs to one creator and may have a
  `sentAt` timestamp when sent.
- **IndexerCursor** stores the last processed ledger. The indexer uses it to
  resume from the correct point after a restart; its default ID of `1` makes
  this a single shared cursor rather than one cursor per creator.

Each model's `id` is a primary key, except `ReleasedSlug`, which is keyed by
`slug`. In addition, `Creator.walletAddress`, `Creator.slug`, `Creator.jarId`,
and `Tip.txHash` have unique constraints.
These are enforced by the database, so they also protect against concurrent
requests or indexer runs that race past an application-level pre-check.

## Cache Behaviour

Redis keys below are prefixed with `cache:` by the cache helper. Analytics
entries are keyed by creator ID and query parameters; creator profiles use the
public slug:

| Read | Key (after `cache:` prefix) | TTL |
|------|-----------------------------|-----|
| Tip totals | `analytics:totals:<creatorId>` | 30 seconds |
| Time series | `analytics:timeseries:<creatorId>:<days>` | 30 seconds |
| Top supporters | `analytics:top:<creatorId>:<limit>` | 30 seconds |
| Authenticated recent tips | `analytics:recent:<creatorId>:<limit>:<cursor-or-head>` | 30 seconds |
| Collaborator earnings | `analytics:collaborators:<creatorId>` | 30 seconds |
| Public recent tips | `analytics:public-recent:<slug>:<limit>:<cursor-or-head>` | 15 seconds |
| Public creator profile | `creator:<slug>` | 60 seconds |

Profile claim, rename, profile update, and split update invalidate the affected
`creator:<slug>` entry (rename invalidates both old and new slugs). Analytics
entries are not explicitly invalidated when tips are indexed or creator splits
change; they expire naturally. A creator's dashboard aggregates can therefore
be up to 30 seconds stale, public tip feeds up to 15 seconds stale, and a
cached public profile up to 60 seconds stale. Updating a profile invalidates
its profile key immediately, but does not invalidate cached analytics.

## Environment Variables

Every variable below is read in src/config.ts; `npm run check:env-docs` checks
this list against that file so the two cannot drift apart again.

DATABASE_URL (required) - PostgreSQL connection string
JWT_SECRET (required) - Secret for signing JWTs; must be at least 32 characters (a short secret is brute-forceable)
JWT_EXPIRES_IN - JWT expiration time in time span format (default: 7d; examples: "30m", "12h", "7d")
TIP_SPLITTER_CONTRACT_ID (required) - Deployed contract ID
WEBHOOK_ENCRYPTION_KEY (required in production) - 32-byte AES-256-GCM key as 64 hex characters; generate with `openssl rand -hex 32`. Keep it outside the database and do not change it after webhook secrets are encrypted.
WEBHOOK_ALLOW_PRIVATE_HOSTS - Allow webhook URLs to target private IP addresses (default: false; local development only)
PORT - Server port (default: 3001)
HOST - Server bind address (default: 0.0.0.0)
NODE_ENV - development | production | test (default: development)
REDIS_URL - Redis URL (default: redis://localhost:6379)
REDIS_MAX_RETRIES_PER_REQUEST - Maximum times a Redis command is retried on disconnect before failing (default: 3)
REDIS_ENABLE_READY_CHECK - Whether ready check is performed on Redis connection (default: true)
STELLAR_NETWORK - testnet | mainnet | local (default: testnet)
SOROBAN_RPC_URL - Soroban RPC endpoint (default: https://soroban-testnet.stellar.org)
HORIZON_URL - Horizon REST endpoint (default: https://horizon-testnet.stellar.org)
NETWORK_PASSPHRASE - Stellar network passphrase (default: "Test SDF Network ; September 2015")
USDC_CONTRACT_ID (required on mainnet) - USDC Stellar Asset Contract ID (default on testnet/local: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA, the testnet one)
INDEXER_START_LEDGER - Ledger to begin indexing from (default: 0)
INDEXER_RPC_TIMEOUT_MS - Timeout for indexer RPC calls in milliseconds (default: 5000)
INDEXER_POLL_INTERVAL_MS - How often the indexer polls Soroban RPC for new TipReceived events, in milliseconds (default: 6000)
INDEXER_POLL_LIMIT - Max TipReceived events fetched from Soroban RPC per poll iteration (default: 200)
UNOWNED_TIP_RETENTION_DAYS - Days unowned tips (no creatorId, e.g. sent before a jar was claimed) are kept before pruning (default: 90, 0 disables pruning)
CREATOR_SLUG_HOLD_DAYS - Days a slug released by renaming, claiming, or account deletion stays unavailable (default: 90, 0 disables the hold; deleted accounts have no owner exemption)
PLACEHOLDER_CREATOR_RETENTION_DAYS - Days before an abandoned sign-in placeholder (unclaimed user_xxxxxxxx slug, no tips, webhooks, notifications or released slugs) becomes eligible for deletion (default: 30, 0 disables the job)
PLACEHOLDER_CREATOR_PRUNE_BATCH_SIZE - Rows deleted per statement (default: 500)
PLACEHOLDER_CREATOR_PRUNE_INTERVAL_MINUTES - How often the placeholder pruner runs (default: 60)
MAX_WEBHOOKS_PER_CREATOR - Most webhooks one creator may register (default: 5, 0 removes the cap)
WEBHOOK_DELIVERY_CONCURRENCY - Maximum webhook HTTP requests in flight across the process (default: 10)
WEBHOOK_TIMEOUT_MS - Timeout for a webhook endpoint to answer before the delivery is recorded as failed, in milliseconds (default: 5000)
WEBHOOK_MAX_BODY_SIZE - Max response body bytes captured in delivery logs (default: 1024)
WEBHOOK_MAX_PAYLOAD_SIZE - Max stored delivery payload size in bytes (default: 2048, minimum: 2)
WEBHOOK_DELIVERY_RETENTION_DAYS - Prune successful deliveries older than this (default: 30, 0 disables)
WEBHOOK_DELIVERY_FAILURE_RETENTION_DAYS - Prune failed deliveries older than this (default: 90, 0 disables)
NOTIFICATION_RETENTION_DAYS - Days notification rows are kept (default: 90, 0 keeps them forever)
WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE - Rows deleted per statement (default: 500)
WEBHOOK_DELIVERY_PRUNE_INTERVAL_MINUTES - How often the pruner runs (default: 60)
RESEND_API_KEY - Resend API key (default: "", which disables email)
EMAIL_FROM - From address on tip and email-verification messages (default: tips@novatip.xyz)
EMAIL_MAX_PER_CREATOR_PER_HOUR - Individual tip emails per creator per UTC hour (default: 10; 0 sends digests only)
RATE_LIMIT_MAX - Server-wide request budget per window, for routes with no dedicated limiter (default: 100)
RATE_LIMIT_WINDOW - Window for RATE_LIMIT_MAX, in @fastify/rate-limit's own format (default: "1 minute")
AUTH_CHALLENGE_RATE_LIMIT - Per-IP cap on POST /auth/challenge, req/min (default: 5)
AUTH_VERIFY_RATE_LIMIT - Per-IP cap on POST /auth/verify, req/min (default: 5)
QR_RATE_LIMIT - Per-IP cap on the QR endpoints, req/min (default: 10)
RESOLVE_RATE_LIMIT - Per-IP cap on GET /resolve/:slug, req/min (default: 30)
PUBLIC_RECENT_RATE_LIMIT - Per-IP cap on GET /public/:slug/recent, req/min (default: 30)
APP_BASE_URL - Frontend base URL (default: http://localhost:3000)
API_BASE_URL - Public backend base URL for email confirmation links (default: http://localhost:3001)
CORS_ALLOWED_ORIGINS - Comma-separated origins allowed through CORS in production (default: just APP_BASE_URL; ignored outside production, where any origin is allowed)
METRICS_ENABLED - Enable Prometheus metrics endpoint at /metrics (default: false)
METRICS_TOKEN - Bearer token for /metrics authentication; if empty, /metrics is served unauthenticated and must be protected by external network controls (default: "")

## Metrics

The `/metrics` endpoint exposes Prometheus-compatible metrics for monitoring and
alerting. It is **disabled by default**. Set `METRICS_ENABLED=true` to enable.

### Authentication

Metrics can be protected in two ways:

1. **Bearer token** - Set `METRICS_TOKEN` to a secret value. Requests must
   include `Authorization: Bearer <token>`. This is suitable when the metrics
   endpoint is exposed publicly or to a monitoring system.

2. **Network access control** - Leave `METRICS_TOKEN` empty only if external network controls (such as firewall rules, reverse proxy blocks, or binding `HOST` to a loopback/private interface) prevent unauthorized access to `config.port`. The server does not bind `/metrics` to a separate internal interface automatically.

### Available metrics

**Indexer metrics:**
- `novatip_indexer_cursor_ledger` - Current indexer cursor ledger number
- `novatip_indexer_lag_ledgers` - Number of ledgers the indexer is behind chain head
- `novatip_indexer_last_successful_poll_timestamp` - Unix timestamp of last successful poll
- `novatip_tips_indexed_total` - Total number of tips indexed (counter)

**Webhook metrics:**
- `novatip_webhook_deliveries_total{outcome}` - Total delivery attempts by outcome (success/failure)
- `novatip_webhook_delivery_duration_seconds` - Webhook delivery duration histogram

**HTTP metrics:**
- `novatip_http_requests_total{method,route,status}` - Total HTTP requests
- `novatip_http_request_duration_seconds{method,route,status}` - HTTP request duration histogram

### Example queries

**Alert when indexer falls behind:**
```promql
novatip_indexer_lag_ledgers > 100
```

**Alert on webhook failure rate:**
```promql
rate(novatip_webhook_deliveries_total{outcome="failure"}[5m]) > 0.1
```

**Monitor HTTP error rate:**
```promql
sum(rate(novatip_http_requests_total{status=~"5.."}[5m])) / sum(rate(novatip_http_requests_total[5m])) > 0.01
```

## API reference

The complete machine-readable OpenAPI 3.0 specification is served at
[`/api/v1/openapi.json`](http://localhost:3001/api/v1/openapi.json) in local
development. It describes every route, authentication requirement, parameter,
request body, and response shape.
GET /health - Simple liveness ping
GET /health/live - Liveness (process up, no dependency checks)
GET /health/ready - Readiness (PostgreSQL + Redis reachable; 503 if not)
GET /health/indexer - Indexer cursor, chain gap, last successful poll time, and last poll error
GET /health/version - Public build metadata: package version, build commit, and configured network

POST /auth/challenge - Issue one-time sign-in nonce
POST /auth/verify - Verify signature, return JWT
GET /auth/me - Current user (JWT)

GET /creators/:slug - Public creator profile
GET /creators/check/:slug - Slug availability
POST /creators/claim - Claim a slug (JWT)
PATCH /creators/me - Update profile (JWT)
GET /creators/email/verify?token=... - Confirm a notification email
PATCH /creators/me/splits - Update splits (JWT)

Reserved slugs (api, admin, dashboard, onboarding, settings, login, logout,
auth, support, help, about, terms, privacy, static, _next, novatip — see
RESERVED_SLUGS in creator.service.ts) can't be claimed and are reported as
unavailable by /creators/check/:slug. Run `npm run check:reserved-slugs`
against a given environment to find existing creators who already hold one
of these slugs from before the list existed.

POST /creators/claim derives the on-chain jarId from the claimed slug
("alice" → "@alice"); the body field is optional. A client that does send it
must send the matching value — a mismatched pair is rejected with 400 rather
than overwritten, since it means the caller registered a jar the backend
would not be able to resolve tips against.

POST /creators/claim returns 409 when the slug or jarId is already taken,
including when two requests race for the same one — the database's unique
constraint is the real guard, not just the pre-check. The response body's
error.code is "SLUG_TAKEN" or "JARID_TAKEN" so callers can tell which
field conflicted.

It also returns 409 with error.code "ALREADY_CLAIMED" when the caller
already holds a real slug: a claim is the one-time move off the sign-in
placeholder (user_ plus 8 hex), and a second one would point the slug and
jarId at values the contract has never seen — orphaning the jar registered
on-chain under the old id — while resetting splits to empty. Renaming
(PATCH /creators/me/slug) is how an existing creator switches slugs.

PATCH /creators/me accepts an optional email address, used as the recipient
for tip notifications. It is private: the public creator endpoint and
/resolve/:slug both read through getCreatorBySlug, whose select allowlists the
world-readable columns and omits it. Send null to clear a stored address; omit
the field to leave it unchanged. Adding or changing the address sends a signed
verification link that expires after 24 hours. Tip notification emails are
sent only after confirmation; the profile response includes `emailVerifiedAt`
(`null` while the address is unverified). A link opens
`GET /creators/email/verify?token=...` and confirms the current address once.

displayName, bio and avatarUrl follow the same omit-to-leave-unchanged rule.
Unlike email, they also accept an empty or whitespace-only string as a way to
clear them — a form field that was merely erased shouldn't have to send null
instead. Values are trimmed before storing either way, so " " and "" both
clear the field rather than storing whitespace.

DELETE /creators/me permanently removes the authenticated creator's profile
and places their slug on the configured hold, preventing anyone from claiming
it while old links and on-chain tips may still point to it. Deleted-creator
tokens are rejected for their remaining configured lifetime. It also deletes their notifications, webhooks, and
webhook delivery history, which are account-owned operational data. Indexed
tips are retained because they represent immutable on-chain financial history;
their creator association is cleared so deleting the profile does not erase or
misattribute those records. This deletion cannot remove the creator's on-chain
jar registration.

GET /qr/:slug - QR code SVG
GET /qr/:slug/png - QR code PNG download; optional `?width=` in pixels (64–2048, default 512)
GET /resolve/:slug - Full tip-page data

Tip URLs: the canonical tip page URL is APP_BASE_URL/:slug (no "@" prefix —
the "@" belongs to the on-chain jarId, not the web URL). This is the shape
produced by /qr/:slug, /qr/:slug/png, and the tipUrl field returned by
/resolve/:slug. /@:slug links remain supported by the frontend for
compatibility with codes already printed, but should not be generated by
new integrations.

GET /analytics/totals - Total tips, amount, supporters (JWT)
GET /analytics/timeseries - Daily breakdown ?days=30 (JWT)
GET /analytics/top-supporters- Ranked supporters ?limit=10 (JWT)
GET /analytics/recent - Live tip feed ?limit=20&cursor=<opaque> (JWT)
GET /analytics/export - CSV export of the creator's tip history (JWT)
GET /analytics/collaborators - Per-recipient earnings breakdown (JWT)
GET /notifications - Recent notifications ?limit=20&offset=0&unread=true&cursor=<opaque> (JWT)
POST /notifications/read - Mark notifications as read (JWT)
PATCH /creators/tips/:tipId/message - Hide or unhide a tip message (JWT)

### Error responses

Errors handled by the global error handler use this envelope:

    {
      "error": {
        "code": "SLUG_TAKEN",
        "message": "That slug is already taken."
      }
    }

The HTTP status accompanies the response (for example, a conflict is 409).
In production, the message for any 500 response is replaced with
"An unexpected error occurred." so internal details are not exposed; the
original error is still logged by the server.

Route-level request validation handled with Zod returns a different shape
because routes send `error.flatten()` directly. For example, an invalid slug
can return:

    {
      "error": {
        "formErrors": [],
        "fieldErrors": {
          "slug": ["String must contain at least 3 character(s)"]
        }
      }
    }

Validation responses therefore have `formErrors` and `fieldErrors`, not the
global handler's `code` and `message`.

/analytics/recent is cursor-paginated. It takes ?limit= (1–100, default 20)
and ?cursor=, and returns:

    { "tips": [ { "id", "txHash", "fromAddress", "amount", "message",
                  "ledgerAt" } ],
      "nextCursor": "<opaque string>" | null }

Pass the nextCursor from one response back as ?cursor= to get the page after
it. nextCursor is null when the page reaches the end of the creator's history,
so a client pages until it sees null rather than until it sees an empty page.
amount is stroops as a string (i128 precision) and ledgerAt is ISO 8601 UTC.

The cursor is opaque: it encodes a position in the result set, not a field a
client composes, and its contents are not part of the API. A cursor this server
did not issue is rejected with 400 and error.code "INVALID_CURSOR" rather than
being paged from approximately the right place.

Paging is stable across tips arriving mid-scroll. The ordering is
("ledgerAt" DESC, id DESC) and the cursor names the row the previous page ended
on, so a tip indexed at the head between two requests cannot shift a boundary
that has already been handed out — a client never sees a row twice and never
skips the row a new arrival would have displaced. The id tiebreaker matters:
ledgerAt is not unique, so a page boundary can land inside a group of tips
sharing a ledger close time, and ordering on ledgerAt alone would repeat or
drop the rest of that group. The new arrival is simply not in the pages already
served; it is picked up by the next request to the head.

/analytics/timeseries always returns exactly `days` points, oldest first, one
per UTC calendar day (00:00–23:59:59 UTC) up to and including today. Days
with no tips are included with tipCount: 0 and amountRaw: "0" rather than
omitted, so charts can plot the series directly without gap-filling. Day
boundaries are UTC, not the requesting client's local time zone.

/analytics/collaborators answers "how much has each of us earned" for a shared
jar, which the jar-wide totals could not. It returns:

    { "tipCount": 42,
      "totalAmountRaw": "<stroops>",
      "unallocatedRaw": "<stroops>",
      "collaborators": [ { "to", "bps", "sharePercent", "totalEarnedRaw" } ],
      "basis": { "mode": "current-splits", "splitsUpdatedAt": "<ISO 8601>",
                 "impliedOwnerSplit": false, "note": "..." } }

Every amount is stroops as a string and is handled as a BigInt end to end. A
recipient's total is the sum over tips of floor(amount * bps / 10000), computed
in Postgres `numeric`, not the percentage applied to the jar total: the
contract splits each transfer and truncates each share to a whole stroop, so
applying the percentage to the total would disagree with what the chain
actually paid out by up to a stroop per recipient per tip. Nothing passes
through a float — a JS number starts dropping low digits at about 90 billion
stroops (~9,000 USDC), silently.

unallocatedRaw is whatever the recipients' shares do not account for: the
balance when the splits do not sum to 10000 bps (the contract pays it to the
jar owner) plus the per-tip truncation dust. It is always reported, so
collaborators + unallocatedRaw adds up to totalAmountRaw exactly.

A creator with no splits recorded is not a shared jar: the contract pays the
whole transfer to the jar owner, so the breakdown is a single 100% row for the
creator's wallet address with "impliedOwnerSplit": true, rather than an empty
list that would read as "nobody earned anything".

Tips indexed before a split change: only the creator's current splits are
stored — this database keeps no history of them — so the current percentages
are applied to every indexed tip, including tips that settled on chain under an
earlier split. A breakdown spanning a split change is therefore an
approximation of what each recipient actually received. The response says so in
basis.note and carries basis.splitsUpdatedAt, the last write to the creator
record, so a caller can see that tips after that point are exact. Splits stored
in a shape this endpoint cannot read fail with 500 and error.code
"MALFORMED_SPLITS" rather than quietly dropping a recipient.

GET /public/:slug/recent - Public supporter feed ?limit=20&cursor=<opaque>

/public/:slug/recent is the only unauthenticated view of a creator's tips. The
public tip page shows a supporter feed to visitors who have no account, and
every /analytics route requires the creator's own token, so that feed could not
be read at all before.

It takes ?limit= (1–50, default 20) and ?cursor=, and returns:

    { "tips": [ { "txHash", "fromAddress", "amount", "message", "ledgerAt" } ],
      "nextCursor": "<opaque string>" | null }

The shape is deliberately narrower than /analytics/recent. Sender address,
amount, message and ledger time are already public on chain; the tip's row id
and the creator's id are internal to this database and are omitted. They are
not merely stripped from the response — they are not in the query's select, so
they never reach the Redis cache either. The cursor is keyed on ("ledgerAt",
txHash) rather than the row id for the same reason: the hash is public on
chain, so the cursor carries nothing the response does not.

The page size ceiling is lower than the dashboard's (50 against 100) because
this is an anonymous surface. An unknown slug is a 404, not an empty feed —
otherwise it would be indistinguishable from a creator who has no tips yet.

Responses are cached in Redis for 15 seconds and carry
`Cache-Control: public, max-age=15`, so a browser, a CDN or the frontend's own
fetch cache can reuse one response across visitors to a popular tip page. The
routes live in their own Fastify plugin (src/modules/public/) rather than as an
auth carve-out inside the analytics plugin, whose onRequest hook applies to
every route registered in it.

GET /webhooks - List webhooks (JWT)
POST /webhooks - Register webhook (JWT)
PATCH /webhooks/:id - Enable or disable a webhook (JWT)
DELETE /webhooks/:id - Remove webhook (JWT)

GET /webhooks takes `?limit=` (1–100, default 50) and `?offset=`, the same
paging shape as GET /webhooks/:id/deliveries below. A limit above the
ceiling is a 400 naming it, not a silently shortened page.

POST /webhooks takes `{ "url": "...", "secret": "..." }`; `secret` is optional
and, if omitted, the server mints one with 192 bits of entropy. A
caller-supplied secret must be at least 16 characters — it is the HMAC key a
receiver's signature check is only as strong as, so anything shorter is
rejected with 400 rather than written. The 16-character floor is the same one
rotation enforces (see Rotating the secret).

Webhook destinations must use HTTPS. `localhost`, private, loopback, link-local,
unique-local and other reserved IP addresses are rejected at registration. The
destination is resolved again before every delivery and ping; if any resolved
address is private or reserved, the attempt is refused and recorded as failed.
`WEBHOOK_ALLOW_PRIVATE_HOSTS=true` disables these address restrictions for
local development and should remain off in production.

Webhook secrets are stored as AES-256-GCM ciphertext. Set
`WEBHOOK_ENCRYPTION_KEY` to a unique 32-byte key encoded as 64 hex characters;
the server encrypts existing plaintext webhook secrets during startup before
accepting requests. Back up this key securely: losing or changing it makes the
stored secrets unusable.

POST /webhooks is capped at MAX_WEBHOOKS_PER_CREATOR endpoints per creator
(default 5). Registering beyond it returns 409 with error.code
"WEBHOOK_LIMIT_REACHED" and a message naming the limit and the env var that
sets it; delete an existing webhook to make room. The cap counts every row the
creator holds, enabled or not — PATCH /webhooks/:id can re-enable a disabled
one at any time, so excluding them would make the cap trivial to walk around.
The count and the insert run in one transaction, so two concurrent
registrations cannot both pass the check. Setting MAX_WEBHOOKS_PER_CREATOR=0
removes the cap, which is only sensible for a trusted single-tenant deployment:
dispatchWebhooks fans out to every enabled endpoint on every indexed tip, each
with a five second timeout and a delivery row of its own.

PATCH /webhooks/:id takes `{ "enabled": true | false }` and returns the updated
webhook. It is the way to pause a webhook whose receiver is broken: the secret
is left alone, so re-enabling resumes deliveries against the secret the receiver
already holds — no re-registration and no new secret to distribute. Only the
`enabled` flag is settable this way; a different URL is a different receiver and
should get its own webhook and secret.

The body sends the state it wants rather than asking for a flip, so a client
retrying after a dropped response cannot accidentally re-enable a webhook it
meant to pause. A webhook belonging to another creator answers 404, the same as
one that does not exist.

GET /webhooks/:id/deliveries - Recent delivery attempts (JWT)

Every dispatch attempt is already recorded in WebhookDelivery; this is the way
to read it back. Attempts come newest first, each entry carrying the HTTP status
code the receiver returned, whether it counted as a success (any 2xx), when it
was attempted, and up to 1 KB of the response body:

    {
      "deliveries": [
        {
          "id": "clz...",
          "statusCode": 500,
          "success": false,
          "response": "Internal Server Error",
          "attemptedAt": "2026-10-07T12:34:56.789Z"
        }
      ]
    }

statusCode and response are null when the request never completed — a timeout
(5s) or a connection failure genuinely has no status, and response then holds
the transport error instead.

The request payload is not returned: it is the largest column in the row and the
creator already knows its shape (see Webhook Signatures), whereas what they
cannot otherwise see is what came back.

Paging is `?limit=` (1–100, default 20) and `?offset=`. A limit above the
ceiling is a 400 naming it rather than a silently shortened page. A webhook that
has not fired yet returns an empty array; one belonging to another creator
returns 404.

Filtering by success status: `?success=true` returns only successful deliveries
(2xx responses), and `?success=false` returns only failures. Omit the parameter
to see all attempts. An invalid value (not "true" or "false") returns 400.
This lets creators quickly find failures without paging through pages of
successes on a healthy webhook.

Note that history is not kept forever — see Webhook Delivery Retention for the
windows, which default to 30 days for successes and 90 for failures.

POST /webhooks/:id/ping - Send a signed test payload (JWT)
POST /webhooks/:id/secret - Rotate the signing secret (JWT)

Sends a test delivery to the webhook immediately and returns what the receiver
did with it, so a creator can confirm the URL and their signature check before a
real tip depends on either:

    {
      "delivery": {
        "statusCode": 200,
        "success": true,
        "response": "ok",
        "attemptedAt": "2026-10-07T12:34:56.789Z"
      }
    }

The response is 200 whenever the ping was attempted, including when the receiver
rejected it — the receiver's verdict is `success` in the body. Failing the whole
call would make "your endpoint is broken" indistinguishable from "the ping
endpoint is broken". A webhook belonging to another creator answers 404.

The ping goes out over the same code path, with the same signature, as a real
tip, so a receiver that passes here passes for real. It is also recorded like
any other attempt, so it appears in /webhooks/:id/deliveries and ages out under
the same retention windows.

A disabled webhook is pinged too. That is the intended workflow: pause a broken
receiver (PATCH /webhooks/:id), fix it, ping to confirm, then re-enable. The
`enabled` flag gates automatic dispatch, not an explicit request from the owner.

This route is rate limited to 10 requests per minute per caller, below the
global 100 — it is the only route where the caller picks a URL and has the
server fetch it on demand, and that should not be usable to drive traffic at a
third party.

### Test payload shape

    {
      "event": "webhook.test",
      "test": true,
      "webhookId": "clz...",
      "timestamp": "2026-10-07T12:34:56.789Z"
    }

It is marked as a test twice over, because receivers are written both ways: one
that switches on `event` never matches `tip.received`, and one that ignores
`event` still sees `test: true`. Either way it must not be booked as a tip —
note that the payload carries no amount, sender or jar, so there is no tip to be
reconstructed from it even by a receiver that tries.

The signature is computed over this body exactly as for a tip (see Webhook
Signatures), which is what makes the ping a real test of the receiving side.

## Notifications

Channel preferences live on the creator: `emailEnabled` and `webhookEnabled`,
both booleans defaulting to true, so the migration that added them switched
nothing off for existing creators.

GET /notifications/preferences - Read both flags (JWT)
PATCH /notifications/preferences - Switch either or both (JWT)

Both answer `{ "preferences": { "emailEnabled": true, "webhookEnabled": true } }`.
PATCH takes the same envelope with either key present, so updating one channel
leaves the other untouched, and a key that is present but not a boolean is a
400 rather than a write Postgres would coerce. `{ "preferences": {} }` is a
valid no-op.

The flags are consulted at dispatch: `sendTipNotification` skips quietly
while a creator's `emailEnabled` is false, and `dispatchWebhooks` attempts
nothing at all while `webhookEnabled` is false. The pre-existing gates stay
underneath — a paused per-webhook `enabled` row still applies when the
channel is on, and email still needs an address on record
(PATCH /creators/me).

Every indexed tip for a registered creator creates a `TIP_RECEIVED` row in
`GET /notifications`, regardless of whether email is configured, enabled, or
deliverable. `sentAt` is set only after Resend accepts the email; otherwise
the feed row remains unsent.

Redis is an optional cache for creator profiles and analytics reads. Cache
read failures behave as misses, while cache writes and invalidations are logged
without failing the database-backed request. If an invalidation is missed,
the stale entry is bounded by its configured TTL.

## Indexer

Polls Soroban RPC every 6s for TipReceived events, persists to PostgreSQL,
dispatches webhooks, sends email notifications. Resumes from IndexerCursor.

### Progress status

`GET /api/v1/health/indexer` reports `cursorLedger`, `chainHead`, and `gap`,
along with `lastSuccessfulPollAt` (an ISO timestamp or `null` before any poll
succeeds) and `lastError` (the most recent poll error message, or `null` when
the last poll succeeded).
The chain head includes `status: "known"` and its ledger when the RPC responds;
if the RPC is unreachable it is returned as `status: "unknown"` and `gap` is
`null`, while the persisted cursor is still reported.

### Cursor during quiet periods

An empty batch proves no tips exist between the cursor and chain head, so the
cursor advances to the head rather than staying pinned to the last ledger that
contained a tip. Without this, a restart after a quiet week re-scans every
ledger since — and a cursor old enough to fall outside the RPC's event
retention window makes the first fetch fail outright.

Chain head is read via getLatestLedger _before_ each event fetch, so an empty
result is known to cover everything up to it; reading afterwards could skip a
tip that landed in between. Both the head read and the cursor write are
throttled to once a minute (IDLE_CHECK_INTERVAL_MS in src/indexer/cursor.ts),
so a 6s poll cadence costs neither an extra RPC round trip nor a Postgres write.
A failed head read is logged and skipped — it never blocks event indexing.

### Manual verification against testnet

1. Point .env at testnet with a jar that receives no tips during the test.
2. Start the server (`npm run dev`) and note the cursor:
   `SELECT "lastLedger" FROM "IndexerCursor" WHERE id = 1;`
3. Leave it idle for ~5 minutes. Expect roughly one "idle — advancing cursor"
   log line per minute, not one per 6s poll, and the stored lastLedger tracking
   chain head (compare against getLatestLedger).
4. Restart the server. The "resuming from ledger" line should be within ~12
   ledgers of chain head — before the fix it resumed from the last ledger that
   contained a tip.
5. Point SOROBAN_RPC_URL at an unreachable host and confirm the indexer logs
   "could not read chain head" and keeps polling rather than stalling.

### Cursor semantics

fetchTipEvents treats startLedger as inclusive, so after handling a batch the
loop advances to lastProcessedLedger + 1. IndexerCursor stores the last ledger
processed in full; startup resumes at cursor + 1.

A batch that comes back full (200 events) may have been cut off part-way
through its highest ledger. That ledger is held back and re-fetched on the next
poll rather than skipped — so only ledgers known to be complete are marked done.
Persisting a tip is idempotent (upsert on txHash), but webhook and email
dispatch are not, which is why the cursor must not linger on a handled ledger.

### Reindexing from a chosen ledger

The saved `IndexerCursor` takes precedence over `INDEXER_START_LEDGER` after
the indexer has processed any ledger. To rescan from ledger `N`:

1. Stop the backend and back up the database.
2. Set `INDEXER_START_LEDGER=N` in `.env`, where `N` is the first ledger to
   fetch. Choose a recent ledger that covers the events you need; old Soroban
   events may no longer be available from the RPC provider.
3. Reset the saved cursor so startup uses the configured start ledger:
   `DELETE FROM "IndexerCursor" WHERE id = 1;`
4. Restart the backend. It begins fetching from `N` and persists a new cursor
   as it progresses.

An already-indexed transaction is not inserted a second time: `Tip.txHash` is
the unique key for an upsert, and an existing row is left unchanged. Replaying
its event does still run webhook and email dispatch again; those side effects
are not deduplicated. Consider disabling webhooks and email before a replay if
duplicate notifications would be a problem.

### Switching to a newly deployed contract

Set `TIP_SPLITTER_CONTRACT_ID` to the new contract and choose a start ledger
near its deployment as described in
[Run against a freshly deployed testnet contract](#run-against-a-freshly-deployed-testnet-contract).
Stop the backend and delete the cursor row before restarting, or the saved
cursor will resume indexing at the old position. The `Tip` rows do not record
their source contract or network, so pointing an existing database at another
contract can mix old and new tips in the same creator's analytics. Prefer a
separate database for the new deployment. If reusing a database, back it up
and deliberately remove or archive the old deployment's tip rows before
restarting; resetting the cursor alone does not remove them.

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

## Tip Notifications

Email delivery is supported: the Creator email field was added in
[issue #34](https://github.com/Novatip/novatip-backend/issues/34). Sending
requires RESEND_API_KEY on the server and an address on the creator
(PATCH /creators/me). If either is missing, email is skipped — a creator who
only wants webhooks does not need to provide an address.

`EMAIL_MAX_PER_CREATOR_PER_HOUR` caps individual tip emails per creator per
UTC clock hour (default 10). Tips beyond the cap are still recorded as
TIP_RECEIVED notifications and included in one digest for that creator and
hour, sent shortly after the hour closes. Set the cap to `0` to send no
individual tip emails and use digests only. The background digest sender retries
pending rows if Resend rejects a digest. Email notifications are still gated by
the creator's `emailEnabled` preference.

Resend reports API failures through the returned `error` rather than by
throwing, so a rejected send is checked explicitly. Tip notification rows are
stored pending before delivery; successful individual sends and digests set
`sentAt`, while queued tips remain available for their hourly digest.

Webhook delivery failures are stored in WebhookDelivery and are not retried
([issue #15](https://github.com/Novatip/novatip-backend/issues/15)).

## Webhook Signatures

Each webhook delivery carries two headers to authenticate origin and prevent replay attacks:

- `X-Novatip-Signature`: `sha256=<hex>`
- `X-Novatip-Timestamp`: `<unix-timestamp-in-seconds>`

### Signed Material & Verification

The signature is computed as an HMAC-SHA256 hex digest over the timestamp and raw request body, separated by a period:

```javascript
const signatureHeader = req.headers["x-novatip-signature"]; // sha256=<hex>
const timestamp = req.headers["x-novatip-timestamp"]; // e.g. "1729166400"
const expectedSignature =
  "sha256=" +
  createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

// 1. Verify signatures match in constant time
const valid = crypto.timingSafeEqual(
  Buffer.from(signatureHeader),
  Buffer.from(expectedSignature),
);

// 2. Reject replays older than tolerance (e.g. 5 minutes)
const now = Math.floor(Date.now() / 1000);
const tolerance = 300;
const fresh = Math.abs(now - parseInt(timestamp, 10)) <= tolerance;
```

The secret is returned exactly twice in its life: in the POST /webhooks response
that created the webhook, and in a POST /webhooks/:id/secret response that
rotated it. No route reads one back out, so a lost secret cannot be recovered —
it can only be replaced.

### Verifying a signature

What is signed is `${timestamp}.${rawBody}`, where `rawBody` is the exact
`Content-Type: application/json` request body as it goes out on the wire, before
your framework parses it. Verify against those raw bytes, not against
`JSON.stringify(req.body)` after parsing: re-serialising a parsed object can
reorder keys or change whitespace, which changes the signature. Most frameworks
need to be told explicitly to keep the raw body around for this (Express:
`express.raw()` or `express.json({ verify })`; Fastify: `rawBody` via
`@fastify/raw-body` or a custom `preParsing` hook).

Worked example. A real tip delivery sends a body shaped like:

`txHash` is the Soroban transaction hash for the tip. It is part of the signed
body, so receivers can use it to deduplicate retries and find the transaction
on a block explorer.

    {"event":"tip.received","jarId":"@alice","from":"GABC2D3EFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMN","amount":"2.50","amountRaw":"25000000","message":"Great work!","ledger":123456,"timestamp":"2026-10-17T12:00:00.000Z","txHash":"a1b2c3d4..."}

For timestamp `1729166400` and the webhook's secret
`whsec_3f8a9c2b1d7e4f6a8b9c0d1e2f3a4b5c`, compute the header digest with
`createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")`.

Compare the computed digest with a constant-time comparison, not `===` or
`!==`. A plain string comparison returns as soon as it finds the first
mismatched byte, so how long it takes to reject a forged signature leaks how
many leading bytes the forgery got right — enough timing samples let an
attacker recover the correct signature one byte at a time without ever
knowing the secret. `crypto.timingSafeEqual` always takes the same time
regardless of where (or whether) the inputs differ:

    import { createHmac, timingSafeEqual } from "crypto";

    function isValidSignature(
      rawBody: Buffer,
      timestamp: string,
      header: string | undefined,
      secret: string,
    ): boolean {
      if (!header?.startsWith("sha256=")) return false;

      const expected = createHmac("sha256", secret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest("hex");
      const provided = header.slice("sha256=".length);

      // timingSafeEqual throws on a length mismatch rather than returning
      // false, and a forged header is very unlikely to happen to be exactly
      // 64 hex characters — check that first so a short or malformed header
      // is a clean reject instead of a thrown exception.
      const expectedBuf = Buffer.from(expected, "hex");
      const providedBuf = Buffer.from(provided, "hex");
      if (expectedBuf.length !== providedBuf.length) return false;

      return timingSafeEqual(expectedBuf, providedBuf);
    }

### Rotating the secret

POST /webhooks/:id/secret mints a new secret and returns it once, in the same
shape as registration:

    {
      "webhook": {
        "id": "clz...",
        "url": "https://hooks.example.com/novatip",
        "enabled": true,
        "secret": "9f3c…",
        "createdAt": "2026-09-01T10:00:00.000Z",
        "updatedAt": "2026-10-07T12:34:56.789Z"
      }
    }

Nothing but the secret changes: the webhook keeps its id, URL, enabled flag and
its entire delivery history. That is the difference from the old remedy of
deleting the webhook and registering a new one, which changed the id and broke
anything referencing it. Send `{ "secret": "..." }` (at least 16 characters) to
choose your own, exactly as at registration; omit it and the server generates 24
random bytes, which is the better choice.

Deliveries are signed with whatever secret is stored at the moment they are
dispatched, so the next tip after a rotation uses the new one — no restart, no
cache to clear.

There is no window in which both secrets are accepted. The signature is produced
here and checked by the receiver, so the cutover happens when the receiver's
copy is updated, and a secret being rotated because it leaked needs the old one
dead at once. To rotate without dropping a tip, disable the webhook first
(PATCH /webhooks/:id), update both sides, then re-enable — and POST
/webhooks/:id/ping to confirm the new secret verifies before you do.

## Webhook Failure Notifications

A failed delivery writes a WEBHOOK_FAILED Notification row (payload:
`webhookId`, `url`, `statusCode`) in addition to the WebhookDelivery row every
attempt already gets — otherwise a receiver that has been down for a week is
only visible to a creator who thinks to call GET
/webhooks/:id/deliveries. A successful delivery writes nothing here.

One tip can reach several enabled webhooks, and a receiver that stays down
turns every subsequent tip into another failure, so the notification is
throttled to at most one per webhook per hour rather than one per tip — the
window is counted from the last notification actually written for that
webhook, not from the first failure. Writing the notification can never fail
the dispatch: an error here is logged and swallowed (src/modules/notifications/
webhook-failure.service.ts), the same as a bad webhook URL itself cannot take
down the indexer.

## Webhook Delivery Retention

Every dispatch attempt writes a WebhookDelivery row holding the request payload
and up to 1 KB of the response body — one per tip, per enabled webhook. A
creator with three webhooks generates three rows per tip, so without pruning
this becomes the largest table in the database and starts driving storage and
backup cost long before anyone thinks to look at it.

A background pruner (src/modules/webhooks/retention.ts) deletes aged-out rows
on a schedule. Successes and failures have separate windows: successes are the
bulk of the volume and the least useful, failures are what actually gets
debugged, so they are kept three times as long by default. Setting a window to
0 keeps that class indefinitely; setting both disables the pruner entirely and
logs that it is off at startup.

Deletes run in batches of WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE, selected by id and
then deleted by id, so each statement touches a bounded set of rows even while
new deliveries are being written. A run stops after 50 batches and resumes on
the next tick, which keeps a first run against a large backlog from turning
into one long-held transaction. Each pass reschedules itself on completion
rather than firing on a fixed interval, so a slow run can never overlap the
next one. A failed pass is logged and retried on the next tick.

The prune predicate (`success = ? AND "attemptedAt" < ?`) is served by the
WebhookDelivery_success_attemptedAt_idx index added in
prisma/migrations/20260908000000_webhook_delivery_retention_index.

## Notification Retention

Notification rows are pruned by the existing background retention scheduler
after `NOTIFICATION_RETENTION_DAYS` (default 90 days). Set it to `0` to keep
notifications indefinitely. Deletes use the configured
`WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE` in batches, with a ceiling of 50 batches per
run for notifications so a large backlog cannot block webhook delivery
retention.

Rows whose `createdAt` is strictly older than the cutoff are eligible for
deletion; rows at or newer than the cutoff remain available to
`GET /notifications`.

### Manual verification

1. Seed rows on both sides of a window:
   `INSERT INTO "WebhookDelivery" (id, "webhookId", success, payload, "attemptedAt")
 SELECT gen_random_uuid()::text, '<id>', true, '{}'::jsonb, now() - interval '60 days'
 FROM generate_series(1, 2000);`
2. Start the server and wait for the first run (60s after boot).
3. Expect a "pruned webhook deliveries" log line and the aged rows gone, with
   rows inside the window untouched.
4. Confirm the index is used, not a sequential scan:
   `EXPLAIN DELETE FROM "WebhookDelivery" WHERE success = true AND "attemptedAt" < now() - interval '30 days';`

## Scripts

npm run dev - hot reload
npm run build - compile TypeScript
npm run start - run compiled output
npm run test - jest
npm run test:integration - jest, integration tests only
npm run typecheck - tsc --noEmit
npm run lint - eslint
npm run lint:fix - eslint with --fix
npm run format - prettier --write
npm run db:generate - regenerate Prisma client
npm run db:migrate - apply migrations (dev)
npm run db:migrate:deploy - apply migrations (production)
npm run db:studio - open Prisma Studio
npm run db:seed - seed the @demo creator (safe to re-run)
npm run check:reserved-slugs - report existing creators holding a reserved slug
npm run check:env-docs - check README.md and .env.example document every env var config.ts reads

## License

MIT
