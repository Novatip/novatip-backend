import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["RATE_LIMIT_MAX"] = "2";
process.env["RATE_LIMIT_WINDOW"] = "1 minute";

const rateLimitRedis = createRateLimitRedisMock();

jest.unstable_mockModule("../../modules/health/health.service.js", () => ({
  getReadiness: jest.fn(async () => ({
    status: "ok",
    checks: {
      database: { status: "up", latencyMs: 1 },
      redis: { status: "up", latencyMs: 1 },
    },
  })),
  getIndexerStatus: jest.fn(async () => ({
    status: "ok",
    lastLedger: 100,
    latestLedger: 100,
    lagLedgers: 0,
    lastUpdatedAt: new Date().toISOString(),
  })),
}));

const { config } = await import("../../config.js");
const { healthRoutes } = await import("../../modules/health/health.routes.js");

describe("health endpoints rate limit exemption", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    rateLimitRedis.clear();

    app = Fastify();
    await app.register(rateLimit, {
      max: config.rateLimits.global.max,
      timeWindow: config.rateLimits.global.window,
      redis: rateLimitRedis.redis,
    });
    await app.register(healthRoutes, { prefix: "/health" });
    app.get("/other", async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("exempts /health/live from the global per-IP rate limit", async () => {
    const requests = config.rateLimits.global.max + 3;

    for (let i = 0; i < requests; i++) {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
    }

    expect(rateLimitRedis.calls).toHaveLength(0);
  });

  it("exempts /health/ready, /health/indexer, and /health/version from the global rate limit", async () => {
    const requests = config.rateLimits.global.max + 2;

    for (const path of ["/health/ready", "/health/indexer", "/health/version"]) {
      for (let i = 0; i < requests; i++) {
        const res = await app.inject({ method: "GET", url: path });
        expect(res.statusCode).toBe(200);
      }
    }

    expect(rateLimitRedis.calls).toHaveLength(0);
  });

  it("keeps other routes subject to the global rate limit", async () => {
    const first = await app.inject({ method: "GET", url: "/other" });
    const second = await app.inject({ method: "GET", url: "/other" });
    const third = await app.inject({ method: "GET", url: "/other" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });
});
