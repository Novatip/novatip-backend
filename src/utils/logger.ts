/**
 * utils/logger.ts
 * Thin wrapper around Fastify's built-in pino logger for use outside routes.
 */
import pino from "pino";

export const logger = pino({
  level: process.env["NODE_ENV"] === "production" ? "info" : "debug",
  transport:
    process.env["NODE_ENV"] !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});
