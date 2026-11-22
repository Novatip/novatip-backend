/**
 * health.service.ts
 *
 * Dependency health probes for readiness checks. Verifies that the
 * PostgreSQL and Redis connections the app relies on are actually
 * reachable — not merely configured — so orchestrators can tell a
 * booting or degraded instance apart from a healthy one.
 */

import { db } from "../../db.js";
import { config } from "../../config.js";
import { fetchLatestLedger } from "../../indexer/rpc.js";
import { readCursor } from "../../indexer/persist.js";
import { getIndexerPollStatus } from "../../indexer/status.js";
import { redis } from "../../redis.js";
import { logger } from "../../utils/logger.js";

const healthLogger = logger.child({ component: "health" });

// Two seconds leaves room for a slow dependency while keeping readiness probes
// inside the usual orchestrator timeout window.
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Tracks at most one in-flight probe per dependency so repeated readiness
 * checks during an outage coalesce onto the existing call instead of
 * accumulating abandoned queries or connections.
 */
const inFlightProbes = new Map<string, Promise<void>>();

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

export type IndexerStatusReport = {
  cursorLedger: number;
  chainHead: { status: "known"; ledger: number } | { status: "unknown" };
  gap: number | null;
  lastSuccessfulPollAt: string | null;
  lastError: string | null;
};

/**
 * Report the persisted indexer cursor alongside the current chain head.
 * An unavailable RPC is represented as an unknown head; the cursor remains
 * useful and the status endpoint stays available during RPC outages.
 */
export async function getIndexerStatus(): Promise<IndexerStatusReport> {
  const cursorLedger = await readCursor();
  const pollStatus = getIndexerPollStatus();
  let latestLedger: number;

  try {
    latestLedger = await fetchLatestLedger(
      config.stellar.rpcUrl,
      config.stellar.rpcTimeoutMs,
    );
  } catch (err) {
    healthLogger.warn({ err }, "indexer status could not read chain head");
    return {
      cursorLedger,
      chainHead: { status: "unknown" },
      gap: null,
      ...pollStatus,
    };
  }

  return {
    cursorLedger,
    chainHead: { status: "known", ledger: latestLedger },
    gap: latestLedger - cursorLedger,
    ...pollStatus,
  };
}

/**
 * Run a probe and record whether it succeeded and how long it took.
 * Never throws — a failed dependency is reported as `down`, not an error.
 *
 * Coalesces concurrent calls for the same dependency onto a single in-flight
 * probe so a timed-out check cannot stack orphaned calls during an outage.
 */
async function timed(
  dependency: string,
  probe: () => Promise<void>,
): Promise<DependencyStatus> {
  const start = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  let probePromise = inFlightProbes.get(dependency);
  if (!probePromise) {
    probePromise = probe().finally(() => {
      inFlightProbes.delete(dependency);
    });
    // Avoid unhandled rejections if the underlying probe fails after the
    // timeout race has already returned.
    probePromise.catch(() => undefined);
    inFlightProbes.set(dependency, probePromise);
  }

  try {
    await Promise.race([
      probePromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { status: "up", latencyMs: Date.now() - start };
  } catch (err) {
    healthLogger.error({ err, dependency }, "readiness probe failed");
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Dependency probe failed.",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Probe PostgreSQL with a trivial round-trip query bounded by a transaction
 * and statement-level timeout so a hung database cannot hold a pool
 * connection indefinitely after the client-side race expires.
 */
export async function checkDatabase(): Promise<DependencyStatus> {
  return timed("database", async () => {
    if (typeof db.$transaction === "function") {
      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL statement_timeout = ${PROBE_TIMEOUT_MS}`,
          );
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: PROBE_TIMEOUT_MS, maxWait: PROBE_TIMEOUT_MS },
      );
    } else {
      await db.$queryRaw`SELECT 1`;
    }
  });
}

/**
 * Probe Redis with a PING.
 */
export async function checkRedis(): Promise<DependencyStatus> {
  return timed("redis", async () => {
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
