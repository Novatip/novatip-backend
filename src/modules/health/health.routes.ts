/**
 * health.routes.ts
 *
 * Liveness, readiness and build metadata endpoints for operators and deploy
 * automation. These are public — no JWT required.
 *
 * GET /api/v1/health/live    — process is up (never touches dependencies)
 * GET /api/v1/health/ready   — dependencies (PostgreSQL, Redis) are reachable
 * GET /api/v1/health/version — package version, build commit, configured network
 */

import { readFileSync } from "node:fs";
import type { FastifyPluginAsync } from "fastify";
import { getIndexerStatus, getReadiness } from "./health.service.js";
import { config } from "../../config.js";

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };

    return typeof pkg.version === "string" && pkg.version.trim() !== ""
      ? pkg.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

function getBuildCommit(): string {
  const commit =
    process.env.BUILD_COMMIT ??
    process.env.GIT_COMMIT ??
    process.env.npm_package_git_commit ??
    "";

  return commit.trim() !== "" ? commit.trim() : "unknown";
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /live ──────────────────────────────────────────────────────────────
  // Cheap, dependency-free. Answers "is the process running?" — a `down`
  // response here should trigger a restart, not just a traffic drain.
  app.get("/live", { config: { rateLimit: false } }, async () => ({
    status: "ok",
    ts: new Date().toISOString(),
  }));

  // ── GET /ready ─────────────────────────────────────────────────────────────
  // Answers "can this instance serve traffic?" Returns 503 while any
  // dependency is unreachable so load balancers stop routing to it.
  app.get("/ready", { config: { rateLimit: false } }, async (_request, reply) => {
    const report = await getReadiness();
    const statusCode = report.status === "ok" ? 200 : 503;
    return reply
      .status(statusCode)
      .send({ ...report, ts: new Date().toISOString() });
  });

  // ── GET /indexer ──────────────────────────────────────────────────────────
  // Separate from readiness: indexer progress remains observable when the
  // chain RPC is unavailable.
  app.get("/indexer", { config: { rateLimit: false } }, async () => ({
    ...(await getIndexerStatus()),
    ts: new Date().toISOString(),
  }));

  // ── GET /version ─────────────────────────────────────────────────────────────
  // Public build metadata for deploy verification: clients can confirm the
  // package version and git commit being served without exposing any secrets.
  app.get("/version", { config: { rateLimit: false } }, async () => ({
    version: getPackageVersion(),
    commit: getBuildCommit(),
    network: config.stellar.network,
  }));
};
