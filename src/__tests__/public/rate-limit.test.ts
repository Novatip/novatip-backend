import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["PUBLIC_RECENT_RATE_LIMIT"] = "2";

const rateLimitRedis = createRateLimitRedisMock();
const getPublicRecentTipsMock = jest.fn(async () => ({
  tips: [],
  nextCursor: null,
}));

jest.unstable_mockModule(
  "../../modules/analytics/analytics.service.js",
  () => ({
    getPublicRecentTips: getPublicRecentTipsMock,
    PUBLIC_TIPS_CACHE_SECONDS: 15,
    PUBLIC_TIPS_DEFAULT_LIMIT: 20,
    PUBLIC_TIPS_MAX_LIMIT: 50,
  }),
);
jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
}));

const { publicRoutes } = await import("../../modules/public/public.routes.js");

describe("public recent feed rate limit", () => {
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimitRedis.clear();
  });

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      reply.status(error.statusCode ?? 500).send({
        error: {
          code: error.code ?? "INTERNAL_SERVER_ERROR",
          message: error.message,
        },
      });
    });
    await app.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
      redis: rateLimitRedis.redis,
    });
    await app.register(publicRoutes, { prefix: "/public" });
    await app.ready();
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("shares one Redis-backed IP limit across slugs and instances", async () => {
    const firstApp = await buildApp();
    const secondApp = await buildApp();

    const first = await firstApp.inject({
      method: "GET",
      url: "/public/alice/recent",
    });
    const second = await secondApp.inject({
      method: "GET",
      url: "/public/bob/recent",
    });
    const third = await firstApp.inject({
      method: "GET",
      url: "/public/alice/recent",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({
      error: {
        code: "PUBLIC_RECENT_RATE_LIMITED",
        message: "Too many tip feed requests. Try again in a minute.",
      },
    });
    expect(getPublicRecentTipsMock).toHaveBeenCalledTimes(2);

    const feedCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("novatip-public-recent-rate-limit-"),
    );
    expect(feedCalls).toHaveLength(3);
    expect(
      feedCalls.every(
        (call) => call.key === "novatip-public-recent-rate-limit-127.0.0.1",
      ),
    ).toBe(true);
    expect(
      feedCalls.every((call) => call.max === 2 && call.timeWindow === 60_000),
    ).toBe(true);

    // The dedicated bucket trips long before the global one would.
    const globalCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("fastify-rate-limit-"),
    );
    expect(globalCalls.every((call) => call.max === 100)).toBe(true);

    rateLimitRedis.advanceBy(60_000);
    const afterWindow = await secondApp.inject({
      method: "GET",
      url: "/public/alice/recent",
    });
    expect(afterWindow.statusCode).toBe(200);
    expect(getPublicRecentTipsMock).toHaveBeenCalledTimes(3);
  });
});
