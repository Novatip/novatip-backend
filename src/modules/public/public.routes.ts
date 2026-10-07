/**
 * public.routes.ts
 *
 * Unauthenticated, read-only views of a creator's indexed tips.
 *
 * GET /api/v1/public/:slug/recent   — supporter feed for the public tip page
 *                                     (?limit=20&cursor=<opaque>)
 *
 * Every /analytics route sits behind app.authenticate, so the only way to read
 * a creator's recent tips was with that creator's own token. The public tip
 * page wants to show a supporter feed to visitors who have no account at all.
 *
 * These routes are registered as their own plugin rather than as an exception
 * inside the analytics plugin: that plugin's onRequest hook applies to every
 * route in it, and an "except this one" carve-out is the kind of thing a later
 * edit gets wrong silently. A separate plugin cannot accidentally inherit, or
 * accidentally lose, the wrong auth posture.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  getPublicRecentTips,
  PUBLIC_TIPS_CACHE_SECONDS,
  PUBLIC_TIPS_DEFAULT_LIMIT,
  PUBLIC_TIPS_MAX_LIMIT,
} from "../analytics/analytics.service.js";

const RecentQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PUBLIC_TIPS_MAX_LIMIT)
    .default(PUBLIC_TIPS_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export const publicRoutes: FastifyPluginAsync = async (app) => {
  // No authenticate hook — this plugin is the public surface.

  // ── GET /:slug/recent ──────────────────────────────────────────────────────
  app.get("/:slug/recent", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const parsed = RecentQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const page = await getPublicRecentTips(
      slug,
      parsed.data.limit,
      parsed.data.cursor ?? null,
    );

    // Cached server-side in Redis as well; this lets a browser, a CDN or the
    // frontend's own fetch cache reuse a response for the same window instead
    // of every visitor to a popular tip page costing a round trip.
    reply.header(
      "Cache-Control",
      `public, max-age=${PUBLIC_TIPS_CACHE_SECONDS}`,
    );

    return reply.send(page);
  });
};
