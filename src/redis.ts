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

import Redis from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
});

redis.on("connect", () => {
  console.info("[redis] connected");
});

redis.on("error", (err: Error) => {
  console.error("[redis] connection error:", err.message);
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
export async function setAuthNonce(walletAddress: string, nonce: string): Promise<void> {
  await redis.set(`nonce:${walletAddress}`, nonce, "EX", NONCE_TTL_SECONDS);
}

/**
 * Retrieve and immediately delete a stored auth nonce (single-use).
 * Returns null if the nonce has expired or was never set.
 */
export async function consumeAuthNonce(walletAddress: string): Promise<string | null> {
  const key = `nonce:${walletAddress}`;
  const nonce = await redis.get(key);
  if (nonce) await redis.del(key);
  return nonce;
}

/**
 * Cache a JSON value with a TTL (seconds).
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.set(`cache:${key}`, JSON.stringify(value), "EX", ttlSeconds);
}

/**
 * Retrieve a cached JSON value. Returns null on miss.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redis.get(`cache:${key}`);
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

/**
 * Invalidate a cache entry.
 */
export async function cacheInvalidate(key: string): Promise<void> {
  await redis.del(`cache:${key}`);
}
