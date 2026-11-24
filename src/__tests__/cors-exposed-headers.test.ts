/**
 * __tests__/cors-exposed-headers.test.ts
 *
 * Regression tests for Access-Control-Expose-Headers (#366):
 * - Cross-origin requests to /api/v1/analytics/export and /api/v1/qr/:slug/png
 *   expose Content-Disposition so browser fetch() callers can read the
 *   server-suggested download filename.
 */

import { jest } from "@jest/globals";
import { Readable } from "stream";
import type { FastifyInstance } from "fastify";
import { createRateLimitRedisMock } from "./helpers/rate-limit-redis.helper.js";

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

jest.unstable_mockModule("../db.js", () => ({
  db: {
    creator: {
      findUnique: jest.fn(async () => cachedCreator),
    },
    tip: {
      findMany: jest.fn(async () => []),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../redis.js", () => ({
  redis: rateLimitRedis.redis,
  cacheGet: jest.fn(async () => cachedCreator),
  cacheSet: jest.fn(async () => undefined),
  cacheInvalidate: jest.fn(async () => undefined),
  consumeAuthNonce: jest.fn(async () => null),
  setAuthNonce: jest.fn(async () => undefined),
  revokeCreatorTokens: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../modules/analytics/analytics.service.js", () => ({
  getTotals: jest.fn(),
  getTimeSeries: jest.fn(),
  getTopSupporters: jest.fn(),
  getRecentTips: jest.fn(),
  getPublicRecentTips: jest.fn(),
  getCollaboratorEarnings: jest.fn(),
  RECENT_TIPS_DEFAULT_LIMIT: 20,
  RECENT_TIPS_MAX_LIMIT: 100,
  tipHistoryCsvStream: jest.fn(() => Readable.from(["txHash,amount\n"])),
}));

const { buildServer } = await import("../server.js");

describe("CORS exposedHeaders (#366)", () => {
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

  it("exposes Content-Disposition on cross-origin /api/v1/analytics/export requests", async () => {
    const token = server.jwt.sign({
      sub: "creator-1",
      wallet: cachedCreator.walletAddress,
      slug: "alice",
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/analytics/export",
      headers: {
        origin: "https://novatip.example",
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("alice-tip-history.csv");
    expect(res.headers["access-control-expose-headers"]).toContain(
      "Content-Disposition",
    );
  });

  it("exposes Content-Disposition on cross-origin /api/v1/qr/:slug/png requests", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/qr/alice/png",
      headers: {
        origin: "https://novatip.example",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("novatip-alice.png");
    expect(res.headers["access-control-expose-headers"]).toContain(
      "Content-Disposition",
    );
  });
});
