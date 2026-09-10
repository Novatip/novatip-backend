/**
 * server.ts
 *
 * Builds and configures the Fastify server instance.
 * All plugins, route registration, and lifecycle hooks live here.
 */

import Fastify, {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { disconnectDb } from "./db.js";
import { disconnectRedis, redis } from "./redis.js";

export async function buildServer(): Promise<FastifyInstance> {
  const isProduction = config.nodeEnv === "production";

  const server = Fastify({
    logger: {
      level: isProduction ? "info" : "debug",
      // Spread rather than an explicit undefined — see the note in
      // utils/logger.ts about exactOptionalPropertyTypes.
      ...(isProduction
        ? {}
        : {
            transport: { target: "pino-pretty", options: { colorize: true } },
          }),
    },
  });

  // ── Security plugins ──────────────────────────────────────────────────────
  await server.register(helmet, { contentSecurityPolicy: false });

  await server.register(cors, {
    origin: config.nodeEnv === "production" ? config.appBaseUrl : true,
    credentials: true,
  });

  await server.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    redis,
  });

  // ── Auth plugin ───────────────────────────────────────────────────────────
  await server.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: "7d" },
  });

  // ── Decorators ────────────────────────────────────────────────────────────
  // Convenience decorator so route handlers can call request.authenticate()
  server.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch (err) {
        reply.status(401).send(err);
      }
    },
  );

  // ── Routes ────────────────────────────────────────────────────────────────
  await server.register(
    async (app) => {
      // Simple health check — kept for backward compatibility. Richer
      // liveness/readiness probes live under /health (see healthRoutes).
      app.get("/health", async () => ({
        status: "ok",
        ts: new Date().toISOString(),
      }));

      // Feature routes registered in subsequent commits
      const { healthRoutes } =
        await import("./modules/health/health.routes.js");
      const { authRoutes } = await import("./modules/auth/auth.routes.js");
      const { creatorRoutes } =
        await import("./modules/creator/creator.routes.js");
      const { qrRoutes } = await import("./modules/qr/qr.routes.js");
      const { resolverRoutes } =
        await import("./modules/resolver/resolver.routes.js");
      const { analyticsRoutes } =
        await import("./modules/analytics/analytics.routes.js");
      const { webhookRoutes } =
        await import("./modules/webhooks/webhooks.routes.js");

      await app.register(healthRoutes, { prefix: "/health" });
      await app.register(authRoutes, { prefix: "/auth" });
      await app.register(creatorRoutes, { prefix: "/creators" });
      await app.register(qrRoutes, { prefix: "/qr" });
      await app.register(resolverRoutes, { prefix: "/resolve" });
      await app.register(analyticsRoutes, { prefix: "/analytics" });
      await app.register(webhookRoutes, { prefix: "/webhooks" });
    },
    { prefix: "/api/v1" },
  );

  // ── Global error handler ──────────────────────────────────────────────────
  server.setErrorHandler((error, request, reply) => {
    server.log.error({ err: error, url: request.url }, "Unhandled error");

    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        code: error.code ?? "INTERNAL_SERVER_ERROR",
        message:
          config.nodeEnv === "production" && statusCode === 500
            ? "An unexpected error occurred."
            : error.message,
      },
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  server.addHook("onClose", async () => {
    await Promise.all([disconnectDb(), disconnectRedis()]);
  });

  return server;
}
