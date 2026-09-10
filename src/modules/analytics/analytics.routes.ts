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

const DaysQuery = z.coerce.number().int().min(1).max(365).default(30);
const LimitQuery = z.coerce.number().int().min(1).max(100).default(10);

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  // All analytics routes require a valid JWT
  app.addHook("onRequest", app.authenticate);

  // ── GET /totals ────────────────────────────────────────────────────────────
  app.get("/totals", async (request, reply) => {
    const { user } = request;
    const totals = await getTotals(user.sub);
    return reply.send(totals);
  });

  // ── GET /timeseries ────────────────────────────────────────────────────────
  app.get("/timeseries", async (request, reply) => {
    const { user } = request;
    const query = request.query as Record<string, string>;
    const parsed = DaysQuery.safeParse(query["days"]);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const series = await getTimeSeries(user.sub, parsed.data);
    return reply.send({ series });
  });

  // ── GET /top-supporters ────────────────────────────────────────────────────
  app.get("/top-supporters", async (request, reply) => {
    const { user } = request;
    const query = request.query as Record<string, string>;
    const parsed = LimitQuery.safeParse(query["limit"]);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const supporters = await getTopSupporters(user.sub, parsed.data);
    return reply.send({ supporters });
  });

  // ── GET /recent ────────────────────────────────────────────────────────────
  app.get("/recent", async (request, reply) => {
    const { user } = request;
    const query = request.query as Record<string, string>;
    const parsed = LimitQuery.safeParse(query["limit"] ?? "20");
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tips = await getRecentTips(user.sub, parsed.data);
    return reply.send({ tips });
  });
};
