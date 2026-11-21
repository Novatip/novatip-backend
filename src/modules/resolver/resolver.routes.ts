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
import {
  getCreatorBySlug,
  PROFILE_CACHE_TTL,
} from "../creator/creator.service.js";
import { config } from "../../config.js";
import { validateSlugParam } from "../../utils/validation.js";

export const resolverRoutes: FastifyPluginAsync = async (app) => {
  app.get("/:slug", async (request, reply) => {
    const slug = validateSlugParam(request.params, reply);
    if (slug === null) return;

    const creator = await getCreatorBySlug(slug);

    // Every visit to a public tip page hydrates through here. The profile is
    // already cached server-side for PROFILE_CACHE_TTL; this lets a browser or
    // CDN reuse the response for the same window, as qr.routes.ts and
    // public.routes.ts do for their public responses.
    reply.header("Cache-Control", `public, max-age=${PROFILE_CACHE_TTL}`);

    return reply.send({
      creator,
      tipUrl: `${config.appBaseUrl}/${slug}`,
      qrSvgUrl: `/api/v1/qr/${slug}`,
      qrPngUrl: `/api/v1/qr/${slug}/png`,
    });
  });
};
