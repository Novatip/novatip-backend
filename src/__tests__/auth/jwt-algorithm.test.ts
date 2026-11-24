/**
 * __tests__/auth/jwt-algorithm.test.ts
 *
 * Regression tests for explicit JWT algorithm pinning (#369):
 * - Tokens issued by the server use HS256
 * - Tokens signed with another algorithm (e.g. HS512) are rejected with 401
 */

import { jest } from "@jest/globals";
import { createHmac } from "crypto";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

const JWT_SECRET = "test-secret-at-least-32-chars-long-123456";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] = JWT_SECRET;
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["APP_BASE_URL"] ??= "http://localhost:3000";

const rateLimitRedis = createRateLimitRedisMock();
const wallet = Keypair.random().publicKey();

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: jest.fn(async () => ({
        slug: "alice",
        emailVerifiedAt: null,
      })),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
  consumeAuthNonce: jest.fn(async () => null),
  setAuthNonce: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { buildServer } = await import("../../server.js");

function signHmacToken(
  alg: "HS256" | "HS512",
  secret: string,
  claims: Record<string, unknown>,
): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const digestAlg = alg === "HS256" ? "sha256" : "sha512";
  const signature = createHmac(digestAlg, secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("JWT algorithm pinning (#369)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
    await server.ready();
  });

  beforeEach(() => {
    rateLimitRedis.clear();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("signs tokens with HS256 and accepts them on authenticated routes", async () => {
    const token = server.jwt.sign({
      sub: "creator_123",
      wallet,
      slug: "alice",
    });

    const headerPart = token.split(".")[0]!;
    const header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8"),
    ) as { alg?: string };
    expect(header.alg).toBe("HS256");

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it("rejects tokens signed with a different algorithm (HS512) with 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const hs512Token = signHmacToken("HS512", JWT_SECRET, {
      sub: "creator_123",
      wallet,
      slug: "alice",
      iat: now,
      exp: now + 3600,
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${hs512Token}` },
    });

    expect(res.statusCode).toBe(401);
  });
});
