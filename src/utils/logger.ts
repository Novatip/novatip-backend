/**
 * utils/logger.ts
 * Thin wrapper around Fastify's built-in pino logger for use outside routes.
 */
import pino from "pino";

const isProduction = process.env["NODE_ENV"] === "production";

// `transport` is spread in rather than set to undefined: the tsconfig enables
// exactOptionalPropertyTypes, under which an explicit `undefined` is not a
// valid value for an optional property — the key has to be absent instead.
export const logger = pino({
  level: isProduction ? "info" : "debug",
  ...(isProduction
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
});
