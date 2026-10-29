import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["AUTH_CHALLENGE_RATE_LIMIT"] = "2";
process.env["AUTH_VERIFY_RATE_LIMIT"] = "1";

const rateLimitRedis = createRateLimitRedisMock();
const generateChallengeMock = jest.fn(async () => ({
  message: "sign this challenge",
  nonce: "nonce",
}));
const verifyChallengeMock = jest.fn(
  async (
    _walletAddress: string,
    _message: string,
    _signatureHex: string,
    signJwt: (payload: { sub: string; wallet: string; slug: string }) => string,
  ) => ({
    jwt: signJwt({ sub: "creator_1", wallet: "Gwallet", slug: "alice" }),
    isNewUser: false,
  }),
);

jest.unstable_mockModule("../../modules/auth/auth.service.js", () => ({
  generateChallenge: generateChallengeMock,
  verifyChallenge: verifyChallengeMock,
}));
jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
}));

const { authRoutes } = await import("../../modules/auth/auth.routes.js");

describe("POST /verify rate limit", () => {
  const apps: FastifyInstance[] = [];

  beforeEach(async () => {
    jest.clearAllMocks();
    rateLimitRedis.clear();
  });

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(jwtPlugin, {
      secret: "test-secret-at-least-32-chars-long-123456",
    });
    app.decorate("authenticate", async () => undefined);
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
    await app.register(authRoutes);
    await app.ready();
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("shares the verify limit across instances and expires it after one minute", async () => {
    const firstApp = await buildApp();
    const secondApp = await buildApp();
    const payload = {
      walletAddress: `G${"A".repeat(55)}`,
      message: "signed challenge",
      signatureHex: "0".repeat(128),
    };
    const first = await firstApp.inject({
      method: "POST",
      url: "/verify",
      payload,
    });
    const second = await secondApp.inject({
      method: "POST",
      url: "/verify",
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({
      error: {
        code: "AUTH_RATE_LIMITED",
        message: "Too many auth requests. Try again in a minute.",
      },
    });
    expect(verifyChallengeMock).toHaveBeenCalledTimes(1);

    const verifyCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("novatip-auth-verify-rate-limit-"),
    );
    expect(verifyCalls).toHaveLength(2);
    expect(verifyCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "novatip-auth-verify-rate-limit-127.0.0.1",
          max: 1,
          timeWindow: 60_000,
        }),
      ]),
    );
    const globalCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("fastify-rate-limit-"),
    );
    expect(globalCalls).toHaveLength(2);
    expect(
      globalCalls.every(
        (call) => call.max === 100 && call.timeWindow === 60_000,
      ),
    ).toBe(true);

    rateLimitRedis.advanceBy(60_000);
    const afterWindow = await secondApp.inject({
      method: "POST",
      url: "/verify",
      payload,
    });
    expect(afterWindow.statusCode).toBe(200);
    expect(verifyChallengeMock).toHaveBeenCalledTimes(2);
    expect(
      rateLimitRedis.calls.filter((call) =>
        call.key.startsWith("fastify-rate-limit-"),
      ),
    ).toHaveLength(3);
  });

  it("preserves the challenge limit and its response body", async () => {
    const app = await buildApp();
    const payload = { walletAddress: `G${"A".repeat(55)}` };
    const first = await app.inject({
      method: "POST",
      url: "/challenge",
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/challenge",
      payload,
    });
    const third = await app.inject({
      method: "POST",
      url: "/challenge",
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({
      error: {
        code: "AUTH_RATE_LIMITED",
        message: "Too many auth requests. Try again in a minute.",
      },
    });
    expect(generateChallengeMock).toHaveBeenCalledTimes(2);
    const challengeCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("novatip-auth-challenge-rate-limit-"),
    );
    expect(challengeCalls).toHaveLength(3);
    expect(
      challengeCalls.every(
        (call) =>
          call.key === "novatip-auth-challenge-rate-limit-127.0.0.1" &&
          call.max === 2 &&
          call.timeWindow === 60_000,
      ),
    ).toBe(true);
  });
});
