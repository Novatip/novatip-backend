/**
 * __tests__/public/recent-route.test.ts
 *
 * Route-level coverage for GET /public/:slug/recent.
 *
 * public-recent.test.ts pins the service's output shape and slug-params.test.ts
 * pins the malformed-slug 400, but nothing drove the route itself past that:
 * the unknown-slug 404, the limit/cursor validation in front of the service,
 * a successful page, and the Cache-Control header that lets a browser or CDN
 * reuse it. These run the real plugin and service with db, redis and the
 * creator lookup mocked.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { jest } from "@jest/globals";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const SLUG = "alice";
const CREATOR_ID = "creator_internal_id";

const rateLimitRedis = createRateLimitRedisMock();
const cacheGetMock = jest.fn(async () => null);
const cacheSetMock = jest.fn(async () => undefined);
const tipFindManyMock = jest.fn(async () => [
  {
    txHash: "hash_0002",
    fromAddress: "GSENDER2",
    amount: "2000000",
    message: "second",
    messageHidden: false,
    ledgerAt: new Date("2026-10-20T12:00:00.000Z"),
  },
  {
    txHash: "hash_0001",
    fromAddress: "GSENDER1",
    amount: "1000000",
    message: "first",
    messageHidden: true,
    ledgerAt: new Date("2026-10-19T12:00:00.000Z"),
  },
]);
const getCreatorBySlugMock = jest.fn(async (slug: string) => {
  if (slug !== SLUG) {
    throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
  }
  return { id: CREATOR_ID, slug: SLUG };
});

jest.unstable_mockModule("../../db.js", () => ({
  db: { tip: { findMany: tipFindManyMock } },
  disconnectDb: async (): Promise<void> => undefined,
}));
jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
  cacheGet: cacheGetMock,
  cacheSet: cacheSetMock,
  cacheInvalidate: async (): Promise<void> => undefined,
}));
jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: getCreatorBySlugMock,
}));

const { publicRoutes, RecentQuery } =
  await import("../../modules/public/public.routes.js");
const {
  PUBLIC_TIPS_CACHE_SECONDS,
  PUBLIC_TIPS_DEFAULT_LIMIT,
  PUBLIC_TIPS_MAX_LIMIT,
} = await import("../../modules/analytics/analytics.service.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(publicRoutes, { prefix: "/public" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  rateLimitRedis.clear();
});

function get(url: string) {
  return app.inject({ method: "GET", url });
}

/** The take the service passed to findMany — one lookahead row past the page. */
function requestedTake(): number | undefined {
  const call = tipFindManyMock.mock.calls[0] as unknown as
    [{ take: number }] | undefined;
  return call?.[0].take;
}

describe("GET /public/:slug/recent", () => {
  it("returns a page of public tips with a Cache-Control header", async () => {
    const response = await get(`/public/${SLUG}/recent`);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      `public, max-age=${PUBLIC_TIPS_CACHE_SECONDS}`,
    );
    expect(response.json()).toEqual({
      tips: [
        {
          txHash: "hash_0002",
          fromAddress: "GSENDER2",
          amount: "2000000",
          message: "second",
          ledgerAt: "2026-10-20T12:00:00.000Z",
        },
        {
          txHash: "hash_0001",
          fromAddress: "GSENDER1",
          amount: "1000000",
          message: "",
          ledgerAt: "2026-10-19T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(getCreatorBySlugMock).toHaveBeenCalledWith(SLUG);
    expect(requestedTake()).toBe(PUBLIC_TIPS_DEFAULT_LIMIT + 1);
  });

  it("passes the largest allowed ?limit= through", async () => {
    const response = await get(
      `/public/${SLUG}/recent?limit=${PUBLIC_TIPS_MAX_LIMIT}`,
    );

    expect(response.statusCode).toBe(200);
    expect(requestedTake()).toBe(PUBLIC_TIPS_MAX_LIMIT + 1);
  });

  it("returns 404 for an unknown slug without caching headers", async () => {
    const response = await get("/public/nobody/recent");

    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBeUndefined();
    expect(getCreatorBySlugMock).toHaveBeenCalledWith("nobody");
    expect(tipFindManyMock).not.toHaveBeenCalled();
  });

  it.each(["0", String(PUBLIC_TIPS_MAX_LIMIT + 1), "1.5", "abc"])(
    "rejects ?limit=%s with a 400 before any lookup",
    async (limit) => {
      const response = await get(`/public/${SLUG}/recent?limit=${limit}`);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.any(Object) });
      expect(cacheGetMock).not.toHaveBeenCalled();
      expect(getCreatorBySlugMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty ?cursor= with a 400 before any lookup", async () => {
    const response = await get(`/public/${SLUG}/recent?cursor=`);

    expect(response.statusCode).toBe(400);
    expect(cacheGetMock).not.toHaveBeenCalled();
  });

  it("rejects a cursor this server did not issue with a 400", async () => {
    const response = await get(`/public/${SLUG}/recent?cursor=not-a-cursor`);

    expect(response.statusCode).toBe(400);
    expect(tipFindManyMock).not.toHaveBeenCalled();
  });
});

describe("public RecentQuery", () => {
  it("bounds the limit and requires a non-empty cursor", () => {
    expect(RecentQuery.parse({})).toEqual({ limit: PUBLIC_TIPS_DEFAULT_LIMIT });
    expect(
      RecentQuery.parse({ limit: String(PUBLIC_TIPS_MAX_LIMIT), cursor: "x" }),
    ).toEqual({ limit: PUBLIC_TIPS_MAX_LIMIT, cursor: "x" });
    expect(RecentQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(
      RecentQuery.safeParse({ limit: String(PUBLIC_TIPS_MAX_LIMIT + 1) })
        .success,
    ).toBe(false);
    expect(RecentQuery.safeParse({ cursor: "" }).success).toBe(false);
  });
});
