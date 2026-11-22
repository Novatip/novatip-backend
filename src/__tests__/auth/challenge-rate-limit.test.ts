/**
 * __tests__/auth/challenge-rate-limit.test.ts
 *
 * Tests for POST /auth/challenge and its dedicated per-IP rate limiter (#246):
 * - First non-limited request in a window completes and returns 200
 * - Up to AUTH_CHALLENGE_RATE_LIMIT requests from one IP succeed; the next returns 429
 *   with { error: { code: "AUTH_RATE_LIMITED", message: ... } } and Retry-After
 * - Rate limit resets after the 60s window elapses (controllable clock, no sleep)
 * - Different source IPs (via Fastify inject remoteAddress) are limited independently
 * - Malformed walletAddress (wrong length) returns 400
 */

import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { Keypair } from "@stellar/stellar-sdk";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

const prevEnv = {
  DATABASE_URL: process.env["DATABASE_URL"],
  JWT_SECRET: process.env["JWT_SECRET"],
  TIP_SPLITTER_CONTRACT_ID: process.env["TIP_SPLITTER_CONTRACT_ID"],
  AUTH_CHALLENGE_RATE_LIMIT: process.env["AUTH_CHALLENGE_RATE_LIMIT"],
};

const TEST_CHALLENGE_LIMIT = 3;

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["AUTH_CHALLENGE_RATE_LIMIT"] = String(TEST_CHALLENGE_LIMIT);

const rateLimitRedis = createRateLimitRedisMock();
const setAuthNonceMock = jest.fn(async () => undefined);

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: jest.fn(async () => null),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
  setAuthNonce: setAuthNonceMock,
  consumeAuthNonce: jest.fn(async () => null),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { config } = await import("../../config.js");
const { authRoutes } = await import("../../modules/auth/auth.routes.js");

describe("POST /challenge and its per-IP rate limiter (#246)", () => {
  const apps: FastifyInstance[] = [];
  const walletAddress = Keypair.random().publicKey();

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
      max: config.rateLimits.global.max,
      timeWindow: config.rateLimits.global.window,
      redis: rateLimitRedis.redis,
    });
    await app.register(authRoutes);
    await app.ready();
    apps.push(app);
    return app;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimitRedis.clear();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("completes the first non-limited request in a window without hanging", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/challenge",
      remoteAddress: "203.0.113.10",
      payload: { walletAddress },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { message: string; nonce: string };
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(body.message).toContain(`Nonce: ${body.nonce}`);
    expect(setAuthNonceMock).toHaveBeenCalledTimes(1);
    expect(setAuthNonceMock).toHaveBeenCalledWith(walletAddress, body.nonce);
  });

  it("allows up to AUTH_CHALLENGE_RATE_LIMIT requests from one IP and returns 429 on the next", async () => {
    const app = await buildApp();
    const limit = config.rateLimits.authChallenge;
    expect(limit).toBe(TEST_CHALLENGE_LIMIT);

    for (let i = 0; i < limit; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/challenge",
        remoteAddress: "203.0.113.11",
        payload: { walletAddress },
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/challenge",
      remoteAddress: "203.0.113.11",
      payload: { walletAddress },
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({
      error: {
        code: "AUTH_RATE_LIMITED",
        message: "Too many auth requests. Try again in a minute.",
      },
    });
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(setAuthNonceMock).toHaveBeenCalledTimes(limit);
  });

  it("resets the limiter after the 60-second window elapses", async () => {
    const app = await buildApp();
    const limit = config.rateLimits.authChallenge;

    for (let i = 0; i < limit; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/challenge",
        remoteAddress: "203.0.113.12",
        payload: { walletAddress },
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/challenge",
      remoteAddress: "203.0.113.12",
      payload: { walletAddress },
    });
    expect(blocked.statusCode).toBe(429);

    rateLimitRedis.advanceBy(60_000);

    const afterReset = await app.inject({
      method: "POST",
      url: "/challenge",
      remoteAddress: "203.0.113.12",
      payload: { walletAddress },
    });
    expect(afterReset.statusCode).toBe(200);
    expect(setAuthNonceMock).toHaveBeenCalledTimes(limit + 1);
  });

  it("tracks rate limits independently per source IP", async () => {
    const app = await buildApp();
    const limit = config.rateLimits.authChallenge;

    for (let i = 0; i < limit; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/challenge",
        remoteAddress: "203.0.113.21",
        payload: { walletAddress },
      });
      expect(res.statusCode).toBe(200);
    }

    const blockedFirstIp = await app.inject({
      method: "POST",
      url: "/challenge",
      remoteAddress: "203.0.113.21",
      payload: { walletAddress },
    });
    expect(blockedFirstIp.statusCode).toBe(429);

    const secondIpRes = await app.inject({
      method: "POST",
      url: "/challenge",
      remoteAddress: "203.0.113.22",
      payload: { walletAddress },
    });
    expect(secondIpRes.statusCode).toBe(200);
  });

  it("returns 400 when walletAddress has an invalid length", async () => {
    const app = await buildApp();

    const shortRes = await app.inject({
      method: "POST",
      url: "/challenge",
      remoteAddress: "203.0.113.30",
      payload: { walletAddress: "GSHORT" },
    });

    expect(shortRes.statusCode).toBe(400);
    expect(shortRes.json()).toMatchObject({
      error: {
        formErrors: [],
        fieldErrors: {
          walletAddress: expect.any(Array),
        },
      },
    });
    expect(setAuthNonceMock).not.toHaveBeenCalled();
  });
});
