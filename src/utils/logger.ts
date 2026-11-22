/**
 * utils/logger.ts
 * Thin wrapper around Fastify's built-in pino logger for use outside routes.
 */
import pino, { type LoggerOptions } from "pino";
import { config } from "../config.js";

/**
 * Redact sensitive query parameters from a URL string.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") return url;
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return url;

  const pathname = url.slice(0, qIndex);
  const search = url.slice(qIndex + 1);
  if (!search) return url;

  const parts = search.split("&");
  const sanitized = parts.map((part) => {
    const eqIndex = part.indexOf("=");
    const key = eqIndex === -1 ? part : part.slice(0, eqIndex);
    const lowerKey = decodeURIComponent(key).toLowerCase();
    if (
      lowerKey === "token" ||
      lowerKey.includes("token") ||
      lowerKey.includes("secret") ||
      lowerKey === "key" ||
      lowerKey === "code" ||
      lowerKey === "password" ||
      lowerKey === "signature" ||
      lowerKey === "access_token"
    ) {
      return `${key}=[Redacted]`;
    }
    return part;
  });

  return `${pathname}?${sanitized.join("&")}`;
}

function serializeReq(req: any): any {
  if (!req || typeof req !== "object") return req;
  const base =
    typeof pino.stdSerializers?.req === "function"
      ? pino.stdSerializers.req(req)
      : {
          method: req.method,
          url: req.raw?.url ?? req.url,
          version: req.headers?.["accept-version"],
          hostname: req.hostname,
          remoteAddress: req.ip ?? req.socket?.remoteAddress,
          remotePort: req.socket?.remotePort,
          headers: req.headers,
        };

  if (base && typeof base.url === "string") {
    base.url = redactUrl(base.url);
  }

  if (base && base.query && typeof base.query === "object") {
    const q: Record<string, unknown> = { ...base.query };
    for (const key of Object.keys(q)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === "token" ||
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        lowerKey === "key" ||
        lowerKey === "code" ||
        lowerKey === "password" ||
        lowerKey === "signature" ||
        lowerKey === "access_token"
      ) {
        q[key] = "[Redacted]";
      }
    }
    base.query = q;
  }

  return base;
}

/**
 * The pino options shared by this module's own logger and the one Fastify
 * is built with in server.ts — one definition so a change to level or
 * redaction only has to be made once, rather than in both places and only
 * ever in the one whoever is editing happened to open first.
 *
 * `transport` is spread in rather than set to undefined: the tsconfig enables
 * exactOptionalPropertyTypes, under which an explicit `undefined` is not a
 * valid value for an optional property — the key has to be absent instead.
 */
export function buildLoggerOptions(isProduction: boolean): LoggerOptions {
  return {
    level: isProduction ? "info" : "debug",
    redact: {
      paths: [
        "headers.authorization",
        "headers.cookie",
        "req.headers.authorization",
        "req.headers.cookie",
        "request.headers.authorization",
        "request.headers.cookie",
        "req.query.token",
        "request.query.token",
        "query.token",
      ],
      censor: "[Redacted]",
    },
    serializers: {
      req: serializeReq,
      request: serializeReq,
    },
    ...(isProduction
      ? {}
      : { transport: { target: "pino-pretty", options: { colorize: true } } }),
  };
}

const isProduction = config.nodeEnv === "production";

export const logger = pino(buildLoggerOptions(isProduction));
