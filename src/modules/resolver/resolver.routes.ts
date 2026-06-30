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

export const resolverRoutes: FastifyPluginAsync = async (app) => {

  app.get("/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const creator = await getCreatorBySlug(slug);

    return reply.send({
      creator,
      tipUrl:   `${config.appBaseUrl}/@${slug}`,
      qrSvgUrl: `/api/v1/qr/${slug}`,
      qrPngUrl: `/api/v1/qr/${slug}/png`,
    });
  });
};
