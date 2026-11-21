/**
 * resolver.routes.ts
 *
 * GET /api/v1/resolve/:slug
 *
 * Public endpoint that resolves a creator slug to everything the
 * tip page needs in a single request:
 *   - Creator profile (display name, bio, avatar)
 *   - On-chain jar ID
 *   - Splits configuration
 *   - Tip page URL
 *   - QR code URL
 *
 * Used by novatip-web to hydrate the /@[slug] page on load.
 */

import type { FastifyPluginAsync } from "fastify";
import { getCreatorBySlug } from "../creator/creator.service.js";
import { config } from "../../config.js";
import { validateSlugParam } from "../../utils/validation.js";
import { registerDedicatedRateLimit } from "../../utils/rate-limit.js";

/**
 * The tip page resolves its slug on every view, so under the shared global
 * budget a single popular page (or a scraper) could exhaust that IP's whole
 * allowance on this one cheap, cached route and be throttled on every other
 * public route too. A dedicated per-IP limiter gives it its own bucket,
 * configurable via RESOLVE_RATE_LIMIT (default 30) — see config.ts.
 */
const RESOLVE_RATE_LIMIT = config.rateLimits.resolve;

export const resolverRoutes: FastifyPluginAsync = async (app) => {
  await registerDedicatedRateLimit(app, {
    max: RESOLVE_RATE_LIMIT,
    nameSpace: "novatip-resolve-rate-limit-",
    code: "RESOLVE_RATE_LIMITED",
    message: "Too many resolve requests. Try again in a minute.",
  });

  app.get("/:slug", async (request, reply) => {
    const slug = validateSlugParam(request.params, reply);
    if (slug === null) return;

    const creator = await getCreatorBySlug(slug);

    return reply.send({
      creator,
      tipUrl: `${config.appBaseUrl}/${slug}`,
      qrSvgUrl: `/api/v1/qr/${slug}`,
      qrPngUrl: `/api/v1/qr/${slug}/png`,
    });
  });
};
