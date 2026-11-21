import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["RESOLVE_RATE_LIMIT"] = "2";

const rateLimitRedis = createRateLimitRedisMock();
const getCreatorBySlugMock = jest.fn(async (slug: string) => ({ slug }));

jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: getCreatorBySlugMock,
}));
jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
}));

const { resolverRoutes } =
  await import("../../modules/resolver/resolver.routes.js");

describe("resolve route rate limit", () => {
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
    await app.register(resolverRoutes, { prefix: "/resolve" });
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
      url: "/resolve/alice",
    });
    const second = await secondApp.inject({
      method: "GET",
      url: "/resolve/bob",
    });
    const third = await firstApp.inject({
      method: "GET",
      url: "/resolve/alice",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({
      error: {
        code: "RESOLVE_RATE_LIMITED",
        message: "Too many resolve requests. Try again in a minute.",
      },
    });
    expect(getCreatorBySlugMock).toHaveBeenCalledTimes(2);

    const resolveCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("novatip-resolve-rate-limit-"),
    );
    expect(resolveCalls).toHaveLength(3);
    expect(
      resolveCalls.every(
        (call) => call.key === "novatip-resolve-rate-limit-127.0.0.1",
      ),
    ).toBe(true);
    expect(
      resolveCalls.every(
        (call) => call.max === 2 && call.timeWindow === 60_000,
      ),
    ).toBe(true);

    // The dedicated bucket trips long before the global one would.
    const globalCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("fastify-rate-limit-"),
    );
    expect(globalCalls.every((call) => call.max === 100)).toBe(true);

    rateLimitRedis.advanceBy(60_000);
    const afterWindow = await secondApp.inject({
      method: "GET",
      url: "/resolve/alice",
    });
    expect(afterWindow.statusCode).toBe(200);
    expect(getCreatorBySlugMock).toHaveBeenCalledTimes(3);
  });
});
