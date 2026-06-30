/**
 * analytics.routes.ts
 *
 * All analytics routes are auth-protected — only the creator can see
 * their own dashboard data.
 *
 * GET /api/v1/analytics/totals           — total tips + amount + unique supporters
 * GET /api/v1/analytics/timeseries       — daily breakdown (?days=30)
 * GET /api/v1/analytics/top-supporters   — ranked supporter list (?limit=10)
 * GET /api/v1/analytics/recent           — live feed of recent tips (?limit=20)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  getTotals,
  getTimeSeries,
  getTopSupporters,
  getRecentTips,
} from "./analytics.service.js";

const DaysQuery  = z.coerce.number().int().min(1).max(365).default(30);
const LimitQuery = z.coerce.number().int().min(1).max(100).default(10);

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  // All analytics routes require a valid JWT
  app.addHook("onRequest", (app as any).authenticate);

  // ── GET /totals ────────────────────────────────────────────────────────────
  app.get("/totals", async (request, reply) => {
    const user = (request as any).user as { sub: string };
    const totals = await getTotals(user.sub);
    return reply.send(totals);
  });

  // ── GET /timeseries ────────────────────────────────────────────────────────
  app.get("/timeseries", async (request, reply) => {
    const user  = (request as any).user as { sub: string };
    const query = request.query as Record<string, string>;
    const days  = DaysQuery.parse(query["days"]);
    const series = await getTimeSeries(user.sub, days);
    return reply.send({ series });
  });

  // ── GET /top-supporters ────────────────────────────────────────────────────
  app.get("/top-supporters", async (request, reply) => {
    const user  = (request as any).user as { sub: string };
    const query = request.query as Record<string, string>;
    const limit = LimitQuery.parse(query["limit"]);
    const supporters = await getTopSupporters(user.sub, limit);
    return reply.send({ supporters });
  });

  // ── GET /recent ────────────────────────────────────────────────────────────
  app.get("/recent", async (request, reply) => {
    const user  = (request as any).user as { sub: string };
    const query = request.query as Record<string, string>;
    const limit = LimitQuery.parse(query["limit"] ?? "20");
    const tips  = await getRecentTips(user.sub, limit);
    return reply.send({ tips });
  });
};
