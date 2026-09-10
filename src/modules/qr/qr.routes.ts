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

/**
 * QR generation is CPU-heavy (512 px PNG rasterisation) and the routes are
 * public. The global 100 req/min budget is far too permissive here — a single
 * client can exhaust it with QR requests alone, leaving no capacity for the
 * rest of the API.
 *
 * This dedicated limiter enforces a tighter 10 req/min per IP, configurable
 * via the QR_RATE_LIMIT env variable (default 10).
 */
const QR_RATE_LIMIT = Number(process.env.QR_RATE_LIMIT) || 10;

interface SlidingWindow {
  count: number;
  windowStart: number;
}

function buildQrRateLimiter(
  limit: number,
  windowMs: number = 60_000,
): (request: any, reply: any) => void {
  const clients = new Map<string, SlidingWindow>();

  return (request: any, reply: any) => {
    const ip = request.ip;
    const now = Date.now();
    let entry = clients.get(ip);

    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 1, windowStart: now };
      clients.set(ip, entry);
      return;
    }

    entry.count += 1;
    if (entry.count > limit) {
      reply.status(429).send({
        error: {
          code: "QR_RATE_LIMITED",
          message: "Too many QR requests. Try again in a minute.",
        },
      });
    }
  };
}

export const qrRoutes: FastifyPluginAsync = async (app) => {
  const qrLimiter = buildQrRateLimiter(QR_RATE_LIMIT);
  app.addHook("preHandler", qrLimiter);

  // ── GET /:slug — SVG ───────────────────────────────────────────────────────
  app.get("/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    // Validate the creator exists before generating
    await getCreatorBySlug(slug);

    const tipUrl = `${config.appBaseUrl}/${slug}`;

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

    const tipUrl = `${config.appBaseUrl}/${slug}`;

    const pngBuffer = await QRCode.toBuffer(tipUrl, {
      type: "png",
      margin: 2,
      width: 512,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return reply
      .header("Content-Type", "image/png")
      .header(
        "Content-Disposition",
        `attachment; filename="novatip-${slug}.png"`,
      )
      .header("Cache-Control", "public, max-age=3600")
      .send(pngBuffer);
  });
};
