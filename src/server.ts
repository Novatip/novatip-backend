/**
 * server.ts
 *
 * Builds and configures the Fastify server instance.
 * All plugins, route registration, and lifecycle hooks live here.
 */

import Fastify, {
  FastifyInstance,
  RouteOptions,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { disconnectDb } from "./db.js";
import { drainWebhookDeliveries } from "./modules/webhooks/webhooks.service.js";
import { disconnectRedis, redis } from "./redis.js";
import { authenticate } from "./modules/auth/authenticate.js";
import { buildLoggerOptions } from "./utils/logger.js";
import { recordHttpRequest } from "./modules/metrics/metrics.service.js";

export interface BuildServerOptions {
  /**
   * Fires once per route registered on the server (including Fastify's
   * automatic HEAD route for every GET). Exists so tests can enumerate the
   * routes this server actually registers — e.g. to check each one has an
   * OpenAPI spec entry — without hand-maintaining a second list that can
   * drift from this one.
   */
  onRoute?: (routeOptions: RouteOptions & { url: string }) => void;
}

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const isProduction = config.nodeEnv === "production";

  const server = Fastify({
    logger: buildLoggerOptions(isProduction),
    trustProxy: config.trustProxy > 0 ? config.trustProxy : false,
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.connectionTimeoutMs,
  });

  if (options.onRoute) {
    server.addHook("onRoute", options.onRoute);
  }

  // ── Security plugins ──────────────────────────────────────────────────────
  await server.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  await server.register(cors, {
    origin: isProduction ? config.corsAllowedOrigins : true,
    credentials: true,
  });

  await server.register(rateLimit, {
    max: config.rateLimits.global.max,
    timeWindow: config.rateLimits.global.window,
    redis,
  });

  // ── Auth plugin ───────────────────────────────────────────────────────────
  await server.register(jwt, {
    secret: config.jwtSecret,
    sign: { algorithm: "HS256", expiresIn: config.jwtExpiresIn },
    verify: { algorithms: ["HS256"] },
  });

  // ── Decorators ────────────────────────────────────────────────────────────
  // Convenience decorator so route handlers can call request.authenticate()
  server.decorate(
    "authenticate",
    authenticate,
  );

  // ── HTTP request metrics ──────────────────────────────────────────────────
  if (config.metricsEnabled) {
    server.addHook("onRequest", async (request) => {
      (request as any).startTime = Date.now();
    });

    server.addHook("onResponse", async (request, reply) => {
      const startTime = (request as any).startTime;
      if (startTime) {
        const durationSeconds = (Date.now() - startTime) / 1000;
        const route = request.routeOptions?.url || "unmatched_route";
        recordHttpRequest(request.method, route, reply.statusCode, durationSeconds);
      }
    });
  }

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
      const { notificationRoutes } =
        await import("./modules/notifications/notifications.routes.js");
      const { publicRoutes } =
        await import("./modules/public/public.routes.js");
      const { openApiRoutes } =
        await import("./modules/openapi/openapi.routes.js");

      await app.register(healthRoutes, { prefix: "/health" });
      await app.register(authRoutes, { prefix: "/auth" });
      await app.register(creatorRoutes, { prefix: "/creators" });
      await app.register(qrRoutes, { prefix: "/qr" });
      await app.register(resolverRoutes, { prefix: "/resolve" });
      await app.register(analyticsRoutes, { prefix: "/analytics" });
      await app.register(webhookRoutes, { prefix: "/webhooks" });
      await app.register(notificationRoutes, { prefix: "/notifications" });
      await app.register(publicRoutes, { prefix: "/public" });
      await app.register(openApiRoutes);
    },
    { prefix: "/api/v1" },
  );

  // Prometheus scrapes /metrics at the root, outside the versioned API.
  // metricsRoutes registers nothing unless METRICS_ENABLED is set.
  const { metricsRoutes } = await import("./modules/metrics/metrics.routes.js");
  await server.register(metricsRoutes);

  server.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });

  // ── Global error handler ──────────────────────────────────────────────────
  const CLIENT_ERROR_CODES: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    429: "TOO_MANY_REQUESTS",
  };

  server.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const isServerError = statusCode >= 500;
    const isClientError = statusCode >= 400 && statusCode < 500;

    if (isServerError) {
      server.log.error({ err: error, url: request.url }, "Server error");
    } else {
      server.log.warn({ err: error, url: request.url }, "Client error");
    }

    const fallbackCode = isClientError
      ? (CLIENT_ERROR_CODES[statusCode] ?? "CLIENT_ERROR")
      : "INTERNAL_SERVER_ERROR";

    reply.status(statusCode).send({
      error: {
        code:
          isProduction && isServerError
            ? "INTERNAL_SERVER_ERROR"
            : (error.code ?? fallbackCode),
        message:
          isProduction && isServerError
            ? "An unexpected error occurred."
            : error.message,
      },
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  server.addHook("onClose", async () => {
    await drainWebhookDeliveries();
    await Promise.all([disconnectDb(), disconnectRedis()]);
  });

  return server;
}
