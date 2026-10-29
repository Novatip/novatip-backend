import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["QR_RATE_LIMIT"] = "2";

const rateLimitRedis = createRateLimitRedisMock();
const getCreatorBySlugMock = jest.fn(async () => ({ slug: "alice" }));
const qrToStringMock = jest.fn(async () => "<svg></svg>");
const qrToBufferMock = jest.fn(async () => Buffer.from("png"));

jest.unstable_mockModule("qrcode", () => ({
  default: {
    toBuffer: qrToBufferMock,
    toString: qrToStringMock,
  },
}));
jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: getCreatorBySlugMock,
}));
jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
}));

const { qrRoutes } = await import("../../modules/qr/qr.routes.js");

describe("QR route rate limit", () => {
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
    await app.register(qrRoutes, { prefix: "/qr" });
    await app.ready();
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("shares one Redis-backed IP limit across QR endpoints and instances", async () => {
    const firstApp = await buildApp();
    const secondApp = await buildApp();

    const first = await firstApp.inject({ method: "GET", url: "/qr/alice" });
    const second = await secondApp.inject({
      method: "GET",
      url: "/qr/alice/png",
    });
    const third = await firstApp.inject({ method: "GET", url: "/qr/alice" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({
      error: {
        code: "QR_RATE_LIMITED",
        message: "Too many QR requests. Try again in a minute.",
      },
    });
    expect(qrToStringMock).toHaveBeenCalledTimes(1);
    expect(qrToBufferMock).toHaveBeenCalledTimes(1);

    const qrCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("novatip-qr-rate-limit-"),
    );
    expect(qrCalls).toHaveLength(3);
    const globalCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("fastify-rate-limit-"),
    );
    expect(globalCalls).toHaveLength(3);
    expect(
      globalCalls.every(
        (call) => call.max === 100 && call.timeWindow === 60_000,
      ),
    ).toBe(true);
    expect(
      qrCalls.every((call) => call.key === "novatip-qr-rate-limit-127.0.0.1"),
    ).toBe(true);
    expect(
      qrCalls.every((call) => call.max === 2 && call.timeWindow === 60_000),
    ).toBe(true);

    rateLimitRedis.advanceBy(60_000);
    const afterWindow = await secondApp.inject({
      method: "GET",
      url: "/qr/alice/png",
    });
    expect(afterWindow.statusCode).toBe(200);
    expect(qrToBufferMock).toHaveBeenCalledTimes(2);
  });
});
