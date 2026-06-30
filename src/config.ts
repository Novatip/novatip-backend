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

  resend: {
    apiKey: optional("RESEND_API_KEY", ""),
    from: optional("EMAIL_FROM", "tips@novatip.xyz"),
  },

  appBaseUrl: optional("APP_BASE_URL", "http://localhost:3000"),
} as const;
