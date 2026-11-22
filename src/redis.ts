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
  maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
  enableReadyCheck: config.redis.enableReadyCheck,
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
 * Atomically retrieve and delete a stored auth nonce (single-use).
 * Returns null if the nonce has expired or was never set.
 */
export async function consumeAuthNonce(
  walletAddress: string,
): Promise<string | null> {
  return redis.getdel(`nonce:${walletAddress}`);
}

/**
 * Mark every outstanding token for a deleted creator as revoked until the
 * longest configured JWT lifetime has elapsed.
 */
export async function revokeCreatorTokens(creatorId: string): Promise<void> {
  await redis.set(
    `auth:revoked:${creatorId}`,
    "1",
    "EX",
    config.jwtExpiresInSeconds,
  );
}

/** Check the Redis revocation marker; authenticated requests do no DB lookup. */
export async function areCreatorTokensRevoked(
  creatorId: string,
): Promise<boolean> {
  return (await redis.exists(`auth:revoked:${creatorId}`)) === 1;
}

/**
 * Cache a JSON value with a TTL (seconds).
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const fullKey = `cache:${key}`;
  const serialized = JSON.stringify(value);

  try {
    await redis.set(fullKey, serialized, "EX", ttlSeconds);
  } catch (err) {
    redisLogger.warn({ err, key: fullKey }, "failed to write cache entry");
  }
}

/**
 * Retrieve a cached JSON value. Returns null on miss or Redis failure.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const fullKey = `cache:${key}`;
  let raw: string | null;
  try {
    raw = await redis.get(fullKey);
  } catch (err) {
    redisLogger.warn(
      { err, key: fullKey },
      "cache read failed — treating as a miss",
    );
    return null;
  }

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
  const fullKey = `cache:${key}`;
  try {
    await redis.del(fullKey);
  } catch (err) {
    redisLogger.warn({ err, key: fullKey }, "failed to invalidate cache entry");
  }
}
