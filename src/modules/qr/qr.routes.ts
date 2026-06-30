/**
 * qr.routes.ts
 *
 * GET /api/v1/qr/:slug        — returns QR code as SVG (default)
 * GET /api/v1/qr/:slug/png    — returns QR code as PNG buffer
 *
 * No auth required — QR codes are public so creators can share/print them.
 */

import type { FastifyPluginAsync } from "fastify";
import QRCode from "qrcode";
import { config } from "../../config.js";
import { getCreatorBySlug } from "../creator/creator.service.js";

export const qrRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /:slug — SVG ───────────────────────────────────────────────────────
  app.get("/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    // Validate the creator exists before generating
    await getCreatorBySlug(slug);

    const tipUrl = `${config.appBaseUrl}/@${slug}`;

    const svg = await QRCode.toString(tipUrl, {
      type: "svg",
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return reply
      .header("Content-Type", "image/svg+xml")
      .header("Cache-Control", "public, max-age=3600")
      .send(svg);
  });

  // ── GET /:slug/png — PNG ───────────────────────────────────────────────────
  app.get("/:slug/png", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    await getCreatorBySlug(slug);

    const tipUrl = `${config.appBaseUrl}/@${slug}`;

    const pngBuffer = await QRCode.toBuffer(tipUrl, {
      type: "png",
      margin: 2,
      width: 512,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return reply
      .header("Content-Type", "image/png")
      .header("Content-Disposition", `attachment; filename="novatip-${slug}.png"`)
      .header("Cache-Control", "public, max-age=3600")
      .send(pngBuffer);
  });
};
