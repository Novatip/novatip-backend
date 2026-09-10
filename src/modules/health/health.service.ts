/**
 * health.service.ts
 *
 * Dependency health probes for readiness checks. Verifies that the
 * PostgreSQL and Redis connections the app relies on are actually
 * reachable — not merely configured — so orchestrators can tell a
 * booting or degraded instance apart from a healthy one.
 */

import { db } from "../../db.js";
import { redis } from "../../redis.js";

export interface DependencyStatus {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: "ok" | "degraded";
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
}

/**
 * Run a probe and record whether it succeeded and how long it took.
 * Never throws — a failed dependency is reported as `down`, not an error.
 */
async function timed(probe: () => Promise<void>): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    await probe();
    return { status: "up", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe PostgreSQL with a trivial round-trip query.
 */
export async function checkDatabase(): Promise<DependencyStatus> {
  return timed(async () => {
    await db.$queryRaw`SELECT 1`;
  });
}

/**
 * Probe Redis with a PING.
 */
export async function checkRedis(): Promise<DependencyStatus> {
  return timed(async () => {
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`unexpected ping reply: ${pong}`);
  });
}

/**
 * Aggregate readiness across every backing service. Probes run in
 * parallel; the instance is `ok` only when all dependencies are `up`.
 */
export async function getReadiness(): Promise<ReadinessReport> {
  const [database, redisCheck] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);
  const allUp = database.status === "up" && redisCheck.status === "up";

  return {
    status: allUp ? "ok" : "degraded",
    checks: { database, redis: redisCheck },
  };
}
