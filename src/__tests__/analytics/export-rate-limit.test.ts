/**
 * __tests__/analytics/export-rate-limit.test.ts
 *
 * Regression test for CSV-export rate limiting: only GET /analytics/export
 * should be capped at config.rateLimits.csvExport (5/min by default), while
 * dashboard polling routes like GET /analytics/recent stay on the global
 * budget and do not 429 after 5 requests.
 */

import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Readable } from "node:stream";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const GLOBAL_MAX = 100;

const rateLimitRedis = createRateLimitRedisMock();
const getRecentTipsMock = jest.fn(async () => ({ tips: [], nextCursor: null }));
const tipHistoryCsvStreamMock = jest.fn(() =>
  Readable.from(["txHash,from,amount\n"]),
);

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: jest.fn(async () => ({ slug: "alice" })),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
  cacheGet: async (): Promise<null> => null,
  cacheSet: async (): Promise<void> => undefined,
  cacheInvalidate: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../modules/analytics/analytics.service.js", () => ({
  getTotals: jest.fn(async () => ({
    totalTips: 0,
    totalAmountRaw: "0",
    uniqueSupporters: 0,
  })),
  getTimeSeries: jest.fn(async () => []),
  getTopSupporters: jest.fn(async () => []),
  getRecentTips: getRecentTipsMock,
  getCollaboratorEarnings: jest.fn(async () => ({
    tipCount: 0,
    totalAmountRaw: "0",
    unallocatedRaw: "0",
    collaborators: [],
    basis: {
      mode: "current-splits",
      splitsUpdatedAt: null,
      impliedOwnerSplit: true,
      note: "",
    },
  })),
  RECENT_TIPS_DEFAULT_LIMIT: 20,
  RECENT_TIPS_MAX_LIMIT: 100,
  tipHistoryCsvStream: tipHistoryCsvStreamMock,
}));

const { config } = await import("../../config.js");
const { analyticsRoutes } =
  await import("../../modules/analytics/analytics.routes.js");

describe("analytics CSV export rate limit", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    rateLimitRedis.clear();

    app = Fastify();
    app.decorateRequest("user", null);
    app.decorate("authenticate", async (request) => {
      request.user = { sub: "creator_1", wallet: "GWALLET", slug: "alice" };
    });
    await app.register(rateLimit, {
      max: GLOBAL_MAX,
      timeWindow: "1 minute",
      redis: rateLimitRedis.redis,
    });
    await app.register(analyticsRoutes, { prefix: "/analytics" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows /recent past the CSV export limit without 429 while still limiting /export", async () => {
    const csvLimit = config.rateLimits.csvExport;

    for (let i = 0; i < csvLimit + 5; i++) {
      const recentRes = await app.inject({
        method: "GET",
        url: "/analytics/recent",
      });
      expect(recentRes.statusCode).toBe(200);
    }
    expect(getRecentTipsMock).toHaveBeenCalledTimes(csvLimit + 5);

    for (let i = 0; i < csvLimit; i++) {
      const exportRes = await app.inject({
        method: "GET",
        url: "/analytics/export",
      });
      expect(exportRes.statusCode).toBe(200);
    }

    const limitedExport = await app.inject({
      method: "GET",
      url: "/analytics/export",
    });
    expect(limitedExport.statusCode).toBe(429);
    expect(tipHistoryCsvStreamMock).toHaveBeenCalledTimes(csvLimit);

    // Exhausting /export does not block /recent.
    const recentAfterExport429 = await app.inject({
      method: "GET",
      url: "/analytics/recent",
    });
    expect(recentAfterExport429.statusCode).toBe(200);

    rateLimitRedis.advanceBy(60_000);
    const exportAfterWindow = await app.inject({
      method: "GET",
      url: "/analytics/export",
    });
    expect(exportAfterWindow.statusCode).toBe(200);
  });
});
