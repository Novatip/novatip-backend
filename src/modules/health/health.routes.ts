/**
 * health.routes.ts
 *
 * Liveness and readiness endpoints for container orchestrators and load
 * balancers. These are public — no JWT required.
 *
 * GET /api/v1/health/live   — process is up (never touches dependencies)
 * GET /api/v1/health/ready  — dependencies (PostgreSQL, Redis) are reachable
 */

import type { FastifyPluginAsync } from "fastify";
import { getReadiness } from "./health.service.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /live ──────────────────────────────────────────────────────────────
  // Cheap, dependency-free. Answers "is the process running?" — a `down`
  // response here should trigger a restart, not just a traffic drain.
  app.get("/live", async () => ({
    status: "ok",
    ts: new Date().toISOString(),
  }));

  // ── GET /ready ─────────────────────────────────────────────────────────────
  // Answers "can this instance serve traffic?" Returns 503 while any
  // dependency is unreachable so load balancers stop routing to it.
  app.get("/ready", async (_request, reply) => {
    const report = await getReadiness();
    const statusCode = report.status === "ok" ? 200 : 503;
    return reply
      .status(statusCode)
      .send({ ...report, ts: new Date().toISOString() });
  });
};
