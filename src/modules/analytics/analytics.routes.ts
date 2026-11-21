/**
 * analytics.routes.ts
 *
 * All analytics routes are auth-protected — only the creator can see
 * their own dashboard data.
 *
 * GET /api/v1/analytics/totals           — total tips + amount + unique supporters
 * GET /api/v1/analytics/timeseries       — daily breakdown (?days=30)
 * GET /api/v1/analytics/top-supporters   — ranked supporter list (?limit=10)
 * GET /api/v1/analytics/recent           — live feed of recent tips
 *                                          (?limit=20&cursor=<opaque>)
 * GET /api/v1/analytics/collaborators    — per-recipient earnings breakdown
 */

import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db.js";
import {
  getTotals,
  getTimeSeries,
  getTopSupporters,
  getRecentTips,
  getCollaboratorEarnings,
  RECENT_TIPS_DEFAULT_LIMIT,
  RECENT_TIPS_MAX_LIMIT,
  tipHistoryCsvStream,
} from "./analytics.service.js";

/**
 * Query bounds for the dashboard routes. Exported so they can be unit tested
 * without standing up the server, the same as webhooks.routes.ts's
 * DeliveryQuery/WebhookQuery — they are the endpoints' contract.
 */
export const DaysQuery = z.coerce.number().int().min(1).max(365).default(30);
export const LimitQuery = z.coerce.number().int().min(1).max(100).default(10);

/**
 * The recent feed takes a cursor as well as a limit, so it validates the whole
 * query object rather than a single field.
 *
 * The cursor is opaque — a position in the result set, not a field a client
 * composes — so it is checked only for being a non-empty string here; decoding
 * is what rejects a value this server did not issue.
 */
export const RecentQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(RECENT_TIPS_MAX_LIMIT)
    .default(RECENT_TIPS_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

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
    const parsed = RecentQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    // A cursor this server did not issue throws a 400 out of the decoder; it
    // reaches the client through the global error handler.
    const page = await getRecentTips(
      user.sub,
      parsed.data.limit,
      parsed.data.cursor ?? null,
    );
    return reply.send(page);
  });

  // ── GET /export.csv — CSV download ────────────────────────────────────────
  const exportCsv: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> =
    async (request, reply) => {
      const { user } = request;
      const creator = await db.creator.findUnique({
        where: { id: user.sub },
        select: { slug: true },
      });

      const slug = creator?.slug ?? "creator";
      const filename = `${slug}-tip-history.csv`;

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .header("Cache-Control", "no-store")
        .send(tipHistoryCsvStream(user.sub));
    };

  app.get(
    "/export",
    {
      // Tighter per-route limit than the global budget: each export streams the
      // creator's full tip history, while dashboard polling on /recent and the
      // summary endpoints stays on the global budget.
      config: {
        rateLimit: {
          max: config.rateLimits.csvExport,
          timeWindow: "1 minute",
        },
      },
    },
    exportCsv,
  );

  // ── GET /collaborators ─────────────────────────────────────────────────────
  app.get("/collaborators", async (request, reply) => {
    const { user } = request;
    const breakdown = await getCollaboratorEarnings(user.sub);
    return reply.send(breakdown);
  });
};
