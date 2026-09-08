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
function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Env var ${key} must be an integer, got "${raw}"`);
  }
  return parsed;
}

export const config = {
  port: parseInt(optional("PORT", "3001"), 10),
  host: optional("HOST", "0.0.0.0"),
  nodeEnv: optional("NODE_ENV", "development"),

  databaseUrl: require("DATABASE_URL"),
  redisUrl: optional("REDIS_URL", "redis://localhost:6379"),

  jwtSecret: require("JWT_SECRET"),

  stellar: {
    network: optional("STELLAR_NETWORK", "testnet") as "testnet" | "mainnet" | "local",
    rpcUrl: optional("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org"),
    horizonUrl: optional("HORIZON_URL", "https://horizon-testnet.stellar.org"),
    passphrase: optional("NETWORK_PASSPHRASE", "Test SDF Network ; September 2015"),
    tipSplitterContractId: require("TIP_SPLITTER_CONTRACT_ID"),
    usdcContractId: optional(
      "USDC_CONTRACT_ID",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ),
    indexerStartLedger: parseInt(optional("INDEXER_START_LEDGER", "0"), 10),
  },

  webhooks: {
    /**
     * Delivery-log retention. Every attempt writes a WebhookDelivery row
     * carrying the payload and up to 1 KB of response body, one per tip per
     * enabled webhook — left alone this becomes the largest table in the
     * database. Set either window to 0 to keep that class forever.
     */
    retention: {
      /** Successful deliveries are the bulk of the rows and the least useful. */
      successDays: optionalInt("WEBHOOK_DELIVERY_RETENTION_DAYS", 30),
      /** Failures are kept longer — they are what anyone actually debugs. */
      failureDays: optionalInt("WEBHOOK_DELIVERY_FAILURE_RETENTION_DAYS", 90),
      /** Rows deleted per statement, so a large backlog never locks the table. */
      batchSize: optionalInt("WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE", 500),
      /** How often the pruner wakes up. */
      intervalMinutes: optionalInt("WEBHOOK_DELIVERY_PRUNE_INTERVAL_MINUTES", 60),
    },
  },

  resend: {
    apiKey: optional("RESEND_API_KEY", ""),
    from: optional("EMAIL_FROM", "tips@novatip.xyz"),
  },

  appBaseUrl: optional("APP_BASE_URL", "http://localhost:3000"),
} as const;
