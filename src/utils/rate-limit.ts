import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { redis } from "../redis.js";

export interface DedicatedRateLimitOptions {
  max: number;
  nameSpace: string;
  code: string;
  message: string;
  hook?: "onRequest" | "preHandler";
}

export async function registerDedicatedRateLimit(
  app: FastifyInstance,
  options: DedicatedRateLimitOptions,
): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: options.max,
    timeWindow: 60_000,
    hook: options.hook ?? "onRequest",
    redis,
    nameSpace: options.nameSpace,
    errorResponseBuilder: (_request, _context) =>
      Object.assign(new Error(options.message), {
        statusCode: 429,
        code: options.code,
      }),
  });
}
