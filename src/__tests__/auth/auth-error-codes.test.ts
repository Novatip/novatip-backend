/**
 * __tests__/auth/auth-error-codes.test.ts
 *
 * Tests for stable auth error codes and global error handler 4xx defaults (#248).
 */

import { jest } from "@jest/globals";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";
import {
  buildChallengeMessage,
  signChallengeMessage,
} from "../helpers/auth-challenge.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["APP_BASE_URL"] ??= "http://localhost:3000";

const rateLimitRedis = createRateLimitRedisMock();
const consumeAuthNonceMock =
  jest.fn<(walletAddress: string) => Promise<string | null>>();

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
  consumeAuthNonce: consumeAuthNonceMock,
  setAuthNonce: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { buildServer } = await import("../../server.js");

describe("auth error codes and global error handler (#248)", () => {
  let server: FastifyInstance;
  const kp = Keypair.random();
  const wallet = kp.publicKey();
  const nonce = "0123456789abcdef".repeat(4);

  beforeAll(async () => {
    server = await buildServer();

    // Register test routes throwing code-less 4xx and 5xx errors
    for (const statusCode of [400, 401, 403, 404, 409, 422, 429]) {
      server.get(
        `/test-codeless-${statusCode}`,
        { config: { rateLimit: false } },
        async () => {
          throw Object.assign(new Error(`Error ${statusCode}`), { statusCode });
        },
      );
    }

    server.get(
      "/test-unexpected-500",
      { config: { rateLimit: false } },
      async () => {
        throw new Error("Sensitive internal failure details");
      },
    );

    await server.ready();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimitRedis.clear();
    consumeAuthNonceMock.mockResolvedValue(nonce);
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("POST /api/v1/auth/verify with expired challenge returns 401 CHALLENGE_EXPIRED", async () => {
    const expiredIso = new Date(Date.now() - 60_000).toISOString();
    const message = buildChallengeMessage({
      walletAddress: wallet,
      nonce,
      expiresAt: expiredIso,
    });
    const signatureHex = signChallengeMessage(kp, message);

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { walletAddress: wallet, message, signatureHex },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).not.toBe("INTERNAL_SERVER_ERROR");
    expect(body).toEqual({
      error: {
        code: "CHALLENGE_EXPIRED",
        message: "Challenge message has expired.",
      },
    });
  });

  it("POST /api/v1/auth/verify with nonce-mismatched message returns 401 NONCE_MISSING", async () => {
    const wrongNonce = "fedcba9876543210".repeat(4);
    const message = buildChallengeMessage({
      walletAddress: wallet,
      nonce: wrongNonce,
    });
    const signatureHex = signChallengeMessage(kp, message);

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { walletAddress: wallet, message, signatureHex },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: {
        code: "NONCE_MISSING",
        message: "Message does not contain expected nonce.",
      },
    });
  });

  it("POST /api/v1/auth/challenge with invalid account returns 400 INVALID_ACCOUNT", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      payload: { walletAddress: "X".repeat(56) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: "INVALID_ACCOUNT",
        message: "Invalid Stellar account address.",
      },
    });
  });

  it("POST /api/v1/auth/verify with bad signature returns 401 SIGNATURE_INVALID", async () => {
    const message = buildChallengeMessage({
      walletAddress: wallet,
      nonce,
    });
    const badSignatureHex = "00".repeat(64);

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: {
        walletAddress: wallet,
        message,
        signatureHex: badSignatureHex,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: {
        code: "SIGNATURE_INVALID",
        message: "Signature verification failed. Request a new challenge.",
      },
    });
  });

  it("derives default error codes for code-less 4xx errors", async () => {
    const expected: Array<[number, string]> = [
      [400, "BAD_REQUEST"],
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "CONFLICT"],
      [422, "CLIENT_ERROR"],
      [429, "TOO_MANY_REQUESTS"],
    ];

    for (const [statusCode, expectedCode] of expected) {
      const res = await server.inject({
        method: "GET",
        url: `/test-codeless-${statusCode}`,
      });
      expect(res.statusCode).toBe(statusCode);
      expect(res.json()).toEqual({
        error: {
          code: expectedCode,
          message: `Error ${statusCode}`,
        },
      });
    }
  });

  it("returns 500 INTERNAL_SERVER_ERROR and hides message in production for unexpected errors", async () => {
    const prevNodeEnv = process.env["NODE_ENV"];
    const prevWebhookKey = process.env["WEBHOOK_ENCRYPTION_KEY"];
    process.env["NODE_ENV"] = "production";
    process.env["WEBHOOK_ENCRYPTION_KEY"] = "0".repeat(64);

    let prodServer: FastifyInstance | undefined;
    try {
      jest.resetModules();
      const { buildServer: buildProdServer } =
        await import("../../server.js");
      prodServer = await buildProdServer();
      prodServer.get(
        "/test-prod-500",
        { config: { rateLimit: false } },
        async () => {
          throw new Error("Sensitive internal failure details");
        },
      );
      await prodServer.ready();

      const res = await prodServer.inject({
        method: "GET",
        url: "/test-prod-500",
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred.",
        },
      });
    } finally {
      if (prodServer) await prodServer.close();
      if (prevNodeEnv === undefined) {
        delete process.env["NODE_ENV"];
      } else {
        process.env["NODE_ENV"] = prevNodeEnv;
      }
      if (prevWebhookKey === undefined) {
        delete process.env["WEBHOOK_ENCRYPTION_KEY"];
      } else {
        process.env["WEBHOOK_ENCRYPTION_KEY"] = prevWebhookKey;
      }
    }
  });
});
