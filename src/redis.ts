/**
 * redis.ts
 *
 * IORedis client singleton for Novatip backend.
 * Used for rate-limit state, challenge nonce storage (auth), and
 * short-lived analytics caching.
 *
 * @example
 * import { redis } from "./redis.js";
 * await redis.set("key", "value", "EX", 60);
 */

// Named import rather than default: ioredis is CJS, and under this project's
// ESM + NodeNext resolution the default export is the module namespace, which
// is not constructable.
import { Redis } from "ioredis";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";

const redisLogger = logger.child({ component: "redis" });

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
});

redis.on("connect", () => {
  redisLogger.info("connected");
});

redis.on("error", (err: Error) => {
  redisLogger.error({ err }, "connection error");
});

/**
 * Gracefully close the Redis connection.
 * Called by the Fastify onClose hook in server.ts.
 */
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const NONCE_TTL_SECONDS = 300; // 5 minutes

/**
 * Store a SIWS auth nonce against a wallet address.
 * Expires after 5 minutes to prevent replay attacks.
 */
export async function setAuthNonce(
  walletAddress: string,
  nonce: string,
): Promise<void> {
  await redis.set(`nonce:${walletAddress}`, nonce, "EX", NONCE_TTL_SECONDS);
}

/**
 * Retrieve and immediately delete a stored auth nonce (single-use).
 * Returns null if the nonce has expired or was never set.
 */
export async function consumeAuthNonce(
  walletAddress: string,
): Promise<string | null> {
  const key = `nonce:${walletAddress}`;
  const nonce = await redis.get(key);
  if (nonce) await redis.del(key);
  return nonce;
}

/**
 * Cache a JSON value with a TTL (seconds).
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(`cache:${key}`, JSON.stringify(value), "EX", ttlSeconds);
}

/**
 * Retrieve a cached JSON value. Returns null on miss.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const fullKey = `cache:${key}`;
  const raw = await redis.get(fullKey);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // A corrupt entry must degrade to a cache miss, never to a 500. Callers
    // treat null as "not cached" and fall through to their source of truth.
    redisLogger.warn(
      { err, key: fullKey },
      "cached value is not valid JSON — evicting",
    );
  }

  // Evict so the next request repopulates it rather than failing until the TTL
  // expires. A failed delete is not worth escalating: the read already
  // succeeded as a miss.
  try {
    await redis.del(fullKey);
  } catch (err) {
    redisLogger.error(
      { err, key: fullKey },
      "failed to evict corrupt cache key",
    );
  }

  return null;
}

/**
 * Invalidate a cache entry.
 */
export async function cacheInvalidate(key: string): Promise<void> {
  await redis.del(`cache:${key}`);
}
