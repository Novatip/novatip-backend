/**
 * config.ts
 *
 * Centralised, validated environment config for novatip-backend.
 * Fails fast at startup if any required variable is missing.
 */

function require(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Read an integer setting, failing fast on a non-numeric value rather than
 * letting NaN reach the code that uses it — a typo'd retention window would
 * otherwise produce an invalid cutoff date and a prune that quietly does
 * nothing (or throws deep inside the scheduler, hours after boot).
 */
function optionalInt(key: string, fallback: number, min?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = raw.trim();
  const parsed = Number(value);
  if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Env var ${key} must be an integer, got "${raw}"`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`Env var ${key} must be >= ${min}, got ${parsed}`);
  }
  return parsed;
}

const STELLAR_NETWORKS = ["testnet", "mainnet", "local"] as const;
type StellarNetwork = (typeof STELLAR_NETWORKS)[number];

function isStellarNetwork(value: string): value is StellarNetwork {
  return (STELLAR_NETWORKS as readonly string[]).includes(value);
}

// Minimum JWT secret length: short enough to type by hand, long enough that
// brute-forcing it is infeasible. A 256-bit (32-byte) secret is the usual
// floor for HMAC signing keys; anything shorter signs real sessions with a
// guessable key.
const MIN_JWT_SECRET_LENGTH = 32;

function validateJwtExpiresIn(value: string): void {
  const validPattern = /^\d+[smhdwy]$/;
  if (!validPattern.test(value)) {
    throw new Error(
      `Env var JWT_EXPIRES_IN must be a valid time span (e.g. "7d", "1h", "30m"), got "${value}"`,
    );
  }
}

/**
 * Read a comma-separated list setting, trimming each entry and dropping
 * empty ones (a trailing comma or stray whitespace shouldn't produce a ""
 * entry that then never matches a real origin).
 */
function optionalList(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Reads an integer setting from its prefixed name only. A legacy,
 * unprefixed name (TIMEOUT_MS, MAX_BODY_SIZE, MAX_PAYLOAD_SIZE) used to be
 * read as a silent fallback — those names are generic enough to be common
 * in shared environments, so a platform setting TIMEOUT_MS for its own
 * purposes would silently retune webhook delivery, and a non-numeric value
 * there would fail boot over a variable the operator never meant for
 * Novatip. The legacy name still works, but logs a warning naming its
 * replacement instead of taking effect invisibly.
 */
function optionalIntDeprecatedFallback(
  key: string,
  legacyKey: string,
  fallback: number,
  min?: number,
): number {
  if (process.env[key] !== undefined) return optionalInt(key, fallback, min);
  if (process.env[legacyKey] !== undefined) {
    // eslint-disable-next-line no-console -- boot-time warning: config.ts loads before the pino logger exists.
    console.warn(
      `Env var ${legacyKey} is deprecated — set ${key} instead. Reading ${legacyKey} for now.`,
    );
    return optionalInt(legacyKey, fallback, min);
  }
  return fallback;
}

function optionalBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;

  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  throw new Error(`Env var ${key} must be "true" or "false", got "${raw}"`);
}

const appBaseUrl = optional("APP_BASE_URL", "http://localhost:3000");
const apiBaseUrl = optional("API_BASE_URL", "http://localhost:3001");
const nodeEnv = optional("NODE_ENV", "development");
const webhookEncryptionKey = optional("WEBHOOK_ENCRYPTION_KEY", "");

if (
  webhookEncryptionKey !== "" &&
  !/^[0-9a-fA-F]{64}$/.test(webhookEncryptionKey)
) {
  throw new Error(
    "Env var WEBHOOK_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes)",
  );
}
if (nodeEnv === "production" && webhookEncryptionKey === "") {
  throw new Error("Missing required env var: WEBHOOK_ENCRYPTION_KEY");
}

const jwtSecretValue = require("JWT_SECRET");
if (jwtSecretValue.length < MIN_JWT_SECRET_LENGTH) {
  throw new Error(
    `Env var JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters ` +
      `(a short secret is brute-forceable), got ${jwtSecretValue.length}`,
  );
}

const jwtExpiresIn = optional("JWT_EXPIRES_IN", "7d");
validateJwtExpiresIn(jwtExpiresIn);
const jwtExpiresInSeconds = (() => {
  const match = /^(\d+)([smhdwy])$/.exec(jwtExpiresIn);
  if (!match) throw new Error("Invalid JWT expiration duration");

  const multiplier: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3_600,
    d: 86_400,
    w: 604_800,
    y: 31_557_600,
  };
  const unit = multiplier[match[2]!];
  if (unit === undefined) throw new Error("Invalid JWT expiration duration");
  const seconds = Number(match[1]) * unit;
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("JWT_EXPIRES_IN exceeds the supported duration");
  }
  return Math.max(1, seconds);
})();

const stellarNetwork = optional("STELLAR_NETWORK", "testnet");
if (!isStellarNetwork(stellarNetwork)) {
  throw new Error(
    `Env var STELLAR_NETWORK must be one of ${STELLAR_NETWORKS.join(", ")}, got "${stellarNetwork}"`,
  );
}

export const config = {
  port: optionalInt("PORT", 3001),
  host: optional("HOST", "0.0.0.0"),
  nodeEnv,

  databaseUrl: require("DATABASE_URL"),
  redisUrl: optional("REDIS_URL", "redis://localhost:6379"),
  redis: {
    url: optional("REDIS_URL", "redis://localhost:6379"),
    maxRetriesPerRequest: optionalInt("REDIS_MAX_RETRIES_PER_REQUEST", 3, 0),
    enableReadyCheck: optionalBoolean("REDIS_ENABLE_READY_CHECK", true),
  },

  jwtSecret: jwtSecretValue,
  jwtExpiresIn,
  jwtExpiresInSeconds,

  stellar: {
    network: stellarNetwork,
    rpcUrl: optional("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org"),
    horizonUrl: optional("HORIZON_URL", "https://horizon-testnet.stellar.org"),
    passphrase: optional(
      "NETWORK_PASSPHRASE",
      "Test SDF Network ; September 2015",
    ),
    tipSplitterContractId: require("TIP_SPLITTER_CONTRACT_ID"),
    // Defaulting this on mainnet would silently point at an asset that
    // doesn't exist there (the fallback below is the *testnet* USDC SAC), so
    // mainnet must set it explicitly; testnet/local keep the convenience
    // default (issue #71).
    usdcContractId:
      stellarNetwork === "mainnet"
        ? require("USDC_CONTRACT_ID")
        : optional(
            "USDC_CONTRACT_ID",
            "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          ),
    indexerStartLedger: optionalInt("INDEXER_START_LEDGER", 0, 0),
    /**
     * How long (in ms) to wait for Soroban RPC requests (e.g. getLatestLedger)
     * before timing out. Defaults to 5,000 ms (5s), which gives a healthy provider
     * sufficient time to return the current ledger sequence without delaying indexer
     * idle checks, while being configurable for slower or distant RPC endpoints to avoid
     * false-positive warnings.
     */
    rpcTimeoutMs: optionalInt("INDEXER_RPC_TIMEOUT_MS", 5_000, 1),
  },

  indexer: {
    /**
     * How often (in ms) the indexer loop polls the Soroban RPC for new TipReceived events.
     * Defaults to 6,000 ms (6 seconds), roughly matching Stellar's ~5s average ledger close time
     * so new events are discovered promptly without hammering the RPC.
     */
    pollIntervalMs: optionalInt("INDEXER_POLL_INTERVAL_MS", 6_000, 1),

    /**
     * Maximum number of TipReceived events fetched from Soroban RPC per poll iteration.
     * Defaults to 200, which provides high throughput during catch-up or backfill
     * without exceeding Soroban RPC getEvents page limits or overwhelming memory.
     */
    pollLimit: optionalInt("INDEXER_POLL_LIMIT", 200, 1),

    /**
     * Days to retain unowned tips before pruning. Tips with no creatorId may
     * belong to another application or have been sent before a jar was claimed.
     * Defaults to 90 days; 0 disables pruning.
     */
    unownedTipRetentionDays: optionalInt("UNOWNED_TIP_RETENTION_DAYS", 90, 0),
  },

  webhooks: {
    encryptionKey: webhookEncryptionKey,
    allowPrivateHosts: optionalBoolean("WEBHOOK_ALLOW_PRIVATE_HOSTS", false),
    /** Maximum number of webhook HTTP requests in flight across the process. */
    deliveryConcurrency: optionalInt("WEBHOOK_DELIVERY_CONCURRENCY", 10, 1),
    /**
     * How long (in ms) to wait for an endpoint to answer before timing out
     * and recording a failed delivery. Defaults to 5,000 ms (5s), giving external
     * endpoints reasonable time to respond without tying up indexer dispatch
     * workers or socket pools indefinitely.
     */
    timeoutMs: optionalIntDeprecatedFallback(
      "WEBHOOK_TIMEOUT_MS",
      "TIMEOUT_MS",
      5_000,
    ),

    /**
     * Maximum response body bytes captured and stored in delivery attempt logs.
     * Defaults to 1,024 bytes (1 KB), keeping enough diagnostics for debugging
     * failures without letting misbehaved endpoints return megabytes of junk to
     * bloat the database.
     */
    maxBodySize: optionalIntDeprecatedFallback(
      "WEBHOOK_MAX_BODY_SIZE",
      "MAX_BODY_SIZE",
      1_024,
      0,
    ),

    /**
     * Maximum stored delivery payload size in bytes.
     * Defaults to 2,048 bytes (2 KB), which easily accommodates standard tip payloads
     * while trimming oversized variable fields (e.g. long messages) to prevent
     * historical delivery logs from ballooning storage. The minimum is 2 bytes
     * so even the smallest valid JSON object (`{}`) fits within the bound.
     */
    maxPayloadSize: optionalIntDeprecatedFallback(
      "WEBHOOK_MAX_PAYLOAD_SIZE",
      "MAX_PAYLOAD_SIZE",
      2_048,
      2,
    ),

    /**
     * Most webhooks one creator may register. Every enabled endpoint is
     * delivered to on every indexed tip, each with its own timeout and its own
     * delivery row, so this bounds how much outbound work a single tip can
     * cause. Set to 0 to remove the cap.
     */
    maxPerCreator: optionalInt("MAX_WEBHOOKS_PER_CREATOR", 5),

    /**
     * Delivery-log retention. Every attempt writes a WebhookDelivery row
     * carrying the payload and up to 1 KB of response body, one per tip per
     * enabled webhook — left alone this becomes the largest table in the
     * database. Set either window to 0 to keep that class forever.
     */
    retention: {
      /** Successful deliveries are the bulk of the rows and the least useful. */
      successDays: optionalInt("WEBHOOK_DELIVERY_RETENTION_DAYS", 30, 0),
      /** Failures are kept longer — they are what anyone actually debugs. */
      failureDays: optionalInt("WEBHOOK_DELIVERY_FAILURE_RETENTION_DAYS", 90, 0),
      /** Rows deleted per statement, so a large backlog never locks the table. */
      batchSize: optionalInt("WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE", 500, 1),
      /** How often the pruner wakes up. */
      intervalMinutes: optionalInt(
        "WEBHOOK_DELIVERY_PRUNE_INTERVAL_MINUTES",
        60,
        1,
      ),
    },
  },

  notifications: {
    /** Stored notifications are pruned after this many days; 0 keeps them. */
    retentionDays: optionalInt("NOTIFICATION_RETENTION_DAYS", 90, 0),
    /**
     * Individual tip emails allowed per creator per UTC clock hour; 0 sends
     * digests only.
     */
    emailMaxPerCreatorPerHour: optionalInt(
      "EMAIL_MAX_PER_CREATOR_PER_HOUR",
      10,
      0,
    ),
  },

  resend: {
    apiKey: optional("RESEND_API_KEY", ""),
    from: optional("EMAIL_FROM", "tips@novatip.xyz"),
  },

  creators: {
    /**
     * Days a slug released by its previous owner stays reserved for them
     * before anyone else may claim it. The rename screen only warns that the
     * old link stops working — it does not say someone else can take the
     * slug over — so a released slug remains held long enough for stale
     * links, printed posters and QR codes to be noticed and rotated. The
     * previous owner is exempt from their own hold throughout. 0 disables
     * the hold, freeing a slug the moment it is released.
     */
    slugHoldDays: optionalInt("CREATOR_SLUG_HOLD_DAYS", 90, 0),

    /**
     * Days after which an abandoned sign-in placeholder — a creator still on
     * its auto-generated user_xxxxxxxx slug, with no tips, webhooks,
     * notifications or released slugs — becomes eligible for deletion. A
     * wallet costs nothing to sign in with, and the per-process challenge
     * rate limit is the only other brake on how many of these accumulate, so
     * this is what ages the abandoned ones out. 0 disables the job and keeps
     * every placeholder forever.
     */
    placeholderRetentionDays: optionalInt(
      "PLACEHOLDER_CREATOR_RETENTION_DAYS",
      30,
      0,
    ),
    /** Rows deleted per statement, so a large backlog never locks the table. */
    placeholderPruneBatchSize: optionalInt(
      "PLACEHOLDER_CREATOR_PRUNE_BATCH_SIZE",
      500,
      1,
    ),
    /** How often the placeholder pruner runs. */
    placeholderPruneIntervalMinutes: optionalInt(
      "PLACEHOLDER_CREATOR_PRUNE_INTERVAL_MINUTES",
      60,
      1,
    ),
  },

  rateLimits: {
    /**
     * The server-wide budget every route not covered by a dedicated limiter
     * shares, enforced in server.ts. 100 req/min is a reasonable guess and
     * the wrong number for both a load test and a busy creator page polling
     * for new tips — RATE_LIMIT_MAX and RATE_LIMIT_WINDOW let an operator
     * tune it per deployment instead of editing the code.
     */
    global: {
      max: optionalInt("RATE_LIMIT_MAX", 100),
      /** @fastify/rate-limit's own format, e.g. "1 minute" or a ms count. */
      window: optional("RATE_LIMIT_WINDOW", "1 minute"),
    },

    /**
     * Per-IP cap on POST /auth/challenge. That route is unauthenticated by
     * nature, so under the shared global budget (100 req/min) a single
     * caller could exhaust the allowance minting nonces for arbitrary wallet
     * addresses, filling Redis with short-lived keys and starving legitimate
     * auth traffic — this is the dedicated, much tighter limit instead.
     */
    authChallenge: optionalInt("AUTH_CHALLENGE_RATE_LIMIT", 5),

    /**
     * Per-IP cap on POST /auth/verify, which validates a Stellar signature and
     * performs database work on success.
     */
    authVerify: optionalInt("AUTH_VERIFY_RATE_LIMIT", 5),

    /**
     * Per-IP cap on the QR endpoints. QR generation is CPU-heavy (512px PNG
     * rasterisation) and public, so the shared global budget is far too
     * permissive — a single client could exhaust it with QR requests alone.
     */
    qr: optionalInt("QR_RATE_LIMIT", 10),

    /**
     * Per-IP cap on GET /resolve/:slug. The tip page calls it on every view,
     * so under the shared global budget a single popular page (or a scraper)
     * could spend that IP's entire allowance on this one cheap, cached route
     * and be throttled on every other public route as a result. Kept below
     * the global budget, together with PUBLIC_RECENT_RATE_LIMIT, so these two
     * routes alone cannot exhaust it.
     */
    resolve: optionalInt("RESOLVE_RATE_LIMIT", 30),

    /**
     * Per-IP cap on GET /public/:slug/recent, the tip page's supporter feed.
     * Same reasoning as RESOLVE_RATE_LIMIT — the page polls it, so it gets
     * its own bucket instead of draining the shared one.
     */
    publicRecent: optionalInt("PUBLIC_RECENT_RATE_LIMIT", 30),

    /**
     * Per-user cap on CSV export. Each call streams a creator's entire tip
     * history through the database in batches of 500.
     */
    csvExport: optionalInt("CSV_EXPORT_RATE_LIMIT", 5),
  },

  appBaseUrl,
  apiBaseUrl,

  /**
   * Origins allowed through CORS in production. The web client deploys to a
   * platform that gives every preview build its own hostname, so a single
   * fixed origin can't cover them; set CORS_ALLOWED_ORIGINS to a
   * comma-separated list to allow more than one. Defaults to just
   * appBaseUrl so an unconfigured deployment keeps today's behaviour.
   */
  corsAllowedOrigins: optionalList("CORS_ALLOWED_ORIGINS", [appBaseUrl]),

  /**
   * Number of proxy hops to trust (e.g. 1 for a single load balancer).
   * When > 0, request.ip is read from X-Forwarded-For. Off by default;
   * enabling without a proxy lets clients spoof their address.
   */
  trustProxy: optionalInt("TRUST_PROXY", 0, 0),

  /**
   * Request timeout in milliseconds. Limits how long the server waits for
   * a complete request body. Defaults to 10 seconds.
   */
  requestTimeoutMs: optionalInt("REQUEST_TIMEOUT_MS", 10_000, 1),

  /**
   * Connection timeout in milliseconds. Limits idle connection time.
   * Defaults to 60 seconds.
   */
  connectionTimeoutMs: optionalInt("CONNECTION_TIMEOUT_MS", 60_000, 1),

  /**
   * Whether GET /metrics serves Prometheus output. Off by default. Read on
   * access rather than once at import, like everything above, so a test can
   * build one server with metrics off and another with them on in the same
   * process.
   */
  get metricsEnabled(): boolean {
    return optionalBoolean("METRICS_ENABLED", false);
  },

  /**
   * Bearer token GET /metrics requires. Empty means no token is checked, so
   * the server should then be bound to an address only the scraper reaches.
   */
  get metricsToken(): string {
    return optional("METRICS_TOKEN", "");
  },
} as const;
