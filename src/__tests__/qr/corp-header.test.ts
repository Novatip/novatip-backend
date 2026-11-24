/**
 * __tests__/qr/corp-header.test.ts
 *
 * Regression tests for Cross-Origin-Resource-Policy on public QR routes (#367):
 * - GET /api/v1/qr/:slug and GET /api/v1/qr/:slug/png send
 *   Cross-Origin-Resource-Policy: cross-origin so browsers allow <img> embeds
 *   from other origins.
 * - Non-QR routes retain Helmet's default Cross-Origin-Resource-Policy: same-origin.
 */

import { jest } from "@jest/globals";
import type { FastifyInstance } from "fastify";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["APP_BASE_URL"] ??= "http://localhost:3000";

const rateLimitRedis = createRateLimitRedisMock();

const cachedCreator = {
  id: "creator-1",
  slug: "alice",
  walletAddress: "GBASZB2BGT6WYIQ57PSXBNLK5PUH5W3ASRUS4DZHHHJW3YQ5ZWGASJJ5",
  jarId: "@alice",
  displayName: "Alice",
  bio: null,
  avatarUrl: null,
  splits: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

jest.unstable_mockModule("qrcode", () => ({
  default: {
    toString: jest.fn(async () => "<svg></svg>"),
    toBuffer: jest.fn(async () => Buffer.from("png-bytes")),
  },
}));

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: jest.fn(async () => cachedCreator),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
  cacheGet: jest.fn(async () => cachedCreator),
  cacheSet: jest.fn(async () => undefined),
  cacheInvalidate: jest.fn(async () => undefined),
  consumeAuthNonce: jest.fn(async () => null),
  setAuthNonce: jest.fn(async () => undefined),
  revokeCreatorTokens: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { buildServer } = await import("../../server.js");

describe("QR Cross-Origin-Resource-Policy (#367)", () => {
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

  it("sends Cross-Origin-Resource-Policy: cross-origin on SVG QR responses", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/qr/alice",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("sends Cross-Origin-Resource-Policy: cross-origin on PNG QR responses", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/qr/alice/png",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("leaves non-QR routes with Helmet's default same-origin CORP header", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });
});
