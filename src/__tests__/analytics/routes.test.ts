/**
 * __tests__/analytics/routes.test.ts
 *
 * Route-level coverage for the authenticated dashboard endpoints.
 *
 * The other analytics suites call analytics.service.ts directly, so the
 * query validation that sits in front of it — DaysQuery, LimitQuery and
 * RecentQuery — had no coverage: an out-of-range ?days= or ?limit= could
 * start reaching the database and nothing would notice. These tests drive
 * the real plugin with app.inject and pin both the 400s and the success
 * responses, plus the schemas' bounds directly.
 *
 * Service results are served from a mocked cache keyed exactly as the
 * service keys them, so a success response also proves which parsed value
 * the route passed through (the default, or the caller's).
 */

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR_ID = "creator-1";

const cache = new Map<string, unknown>();
const cacheGetMock = jest.fn(async (key: string) => cache.get(key) ?? null);
const queryRawMock = jest.fn();
const tipFindManyMock = jest.fn();
const creatorFindUniqueMock = jest.fn(async () => null);

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    $queryRaw: queryRawMock,
    tip: { findMany: tipFindManyMock },
    creator: { findUnique: creatorFindUniqueMock },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: {},
  cacheGet: cacheGetMock,
  cacheSet: async (): Promise<void> => undefined,
  cacheInvalidate: async (): Promise<void> => undefined,
}));

// Only the public feed resolves by slug; none of these routes reach it.
jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: jest.fn(),
}));

// The plugin's CSV-export limiter is covered elsewhere; with it live, this
// suite's request count would trip it.
jest.unstable_mockModule("@fastify/rate-limit", () => ({
  default: async (): Promise<void> => undefined,
}));

const { analyticsRoutes, DaysQuery, LimitQuery, RecentQuery } =
  await import("../../modules/analytics/analytics.routes.js");
const { RECENT_TIPS_DEFAULT_LIMIT, RECENT_TIPS_MAX_LIMIT } =
  await import("../../modules/analytics/analytics.service.js");

const TOTALS = {
  totalTips: 3,
  totalAmountRaw: "30000000",
  uniqueSupporters: 2,
};
const SERIES = [{ date: "2026-10-20", tipCount: 1, amountRaw: "10000000" }];
const SUPPORTERS = [
  { fromAddress: "GSENDER1", tipCount: 2, totalAmountRaw: "20000000" },
];
const RECENT_PAGE = { tips: [], nextCursor: null };
const COLLABORATORS = {
  tipCount: 3,
  totalAmountRaw: "30000000",
  unallocatedRaw: "0",
  collaborators: [],
  basis: {
    mode: "current-splits",
    splitsUpdatedAt: "2026-10-20T00:00:00.000Z",
    impliedOwnerSplit: true,
    note: "",
  },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.decorateRequest("user", null);
  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers.authorization !== "Bearer valid-token") {
        await reply.status(401).send({ error: "unauthorized" });
        return;
      }
      request.user = { sub: CREATOR_ID, wallet: "GWALLET", slug: "alice" };
    },
  );
  await app.register(analyticsRoutes, { prefix: "/analytics" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  cache.clear();
});

function get(url: string, authorized = true) {
  return app.inject({
    method: "GET",
    url,
    ...(authorized ? { headers: { authorization: "Bearer valid-token" } } : {}),
  });
}

/** A 400 must be decided by validation alone, before the service runs. */
function expectNoServiceCall(): void {
  expect(cacheGetMock).not.toHaveBeenCalled();
  expect(queryRawMock).not.toHaveBeenCalled();
  expect(tipFindManyMock).not.toHaveBeenCalled();
}

describe("analytics routes require a token", () => {
  it.each([
    "/analytics/totals",
    "/analytics/timeseries",
    "/analytics/top-supporters",
    "/analytics/recent",
    "/analytics/collaborators",
  ])("GET %s returns 401 without one", async (url) => {
    const response = await get(url, false);

    expect(response.statusCode).toBe(401);
    expectNoServiceCall();
  });
});

describe("GET /analytics/totals", () => {
  it("returns the creator's totals", async () => {
    cache.set(`analytics:totals:${CREATOR_ID}`, TOTALS);

    const response = await get("/analytics/totals");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(TOTALS);
  });
});

describe("GET /analytics/timeseries", () => {
  it("defaults to 30 days", async () => {
    cache.set(`analytics:timeseries:${CREATOR_ID}:30`, SERIES);

    const response = await get("/analytics/timeseries");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ series: SERIES });
  });

  it("passes an in-range ?days= through", async () => {
    cache.set(`analytics:timeseries:${CREATOR_ID}:365`, SERIES);

    const response = await get("/analytics/timeseries?days=365");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ series: SERIES });
  });

  it.each(["0", "366", "-1", "1.5", "abc"])(
    "rejects ?days=%s with a 400",
    async (days) => {
      const response = await get(`/analytics/timeseries?days=${days}`);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.any(Object) });
      expectNoServiceCall();
    },
  );
});

describe("GET /analytics/top-supporters", () => {
  it("defaults to 10 supporters", async () => {
    cache.set(`analytics:top:${CREATOR_ID}:10`, SUPPORTERS);

    const response = await get("/analytics/top-supporters");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ supporters: SUPPORTERS });
  });

  it("passes an in-range ?limit= through", async () => {
    cache.set(`analytics:top:${CREATOR_ID}:100`, SUPPORTERS);

    const response = await get("/analytics/top-supporters?limit=100");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ supporters: SUPPORTERS });
  });

  it.each(["0", "101", "2.5", "abc"])(
    "rejects ?limit=%s with a 400",
    async (limit) => {
      const response = await get(`/analytics/top-supporters?limit=${limit}`);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.any(Object) });
      expectNoServiceCall();
    },
  );
});

describe("GET /analytics/recent", () => {
  it("defaults the page size and starts at the head of the feed", async () => {
    cache.set(
      `analytics:recent:${CREATOR_ID}:${RECENT_TIPS_DEFAULT_LIMIT}:head`,
      RECENT_PAGE,
    );

    const response = await get("/analytics/recent");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(RECENT_PAGE);
  });

  it("passes the largest allowed ?limit= through", async () => {
    cache.set(
      `analytics:recent:${CREATOR_ID}:${RECENT_TIPS_MAX_LIMIT}:head`,
      RECENT_PAGE,
    );

    const response = await get(
      `/analytics/recent?limit=${RECENT_TIPS_MAX_LIMIT}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(RECENT_PAGE);
  });

  it.each(["0", String(RECENT_TIPS_MAX_LIMIT + 1), "abc"])(
    "rejects ?limit=%s with a 400",
    async (limit) => {
      const response = await get(`/analytics/recent?limit=${limit}`);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.any(Object) });
      expectNoServiceCall();
    },
  );

  it("rejects an empty ?cursor= with a 400", async () => {
    const response = await get("/analytics/recent?cursor=");

    expect(response.statusCode).toBe(400);
    expectNoServiceCall();
  });

  it("rejects a cursor this server did not issue with a 400", async () => {
    const response = await get("/analytics/recent?cursor=not-a-cursor");

    expect(response.statusCode).toBe(400);
    expect(tipFindManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /analytics/collaborators", () => {
  it("returns the earnings breakdown", async () => {
    cache.set(`analytics:collaborators:${CREATOR_ID}`, COLLABORATORS);

    const response = await get("/analytics/collaborators");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(COLLABORATORS);
  });

  it("returns 404 when the creator record is gone", async () => {
    const response = await get("/analytics/collaborators");

    expect(response.statusCode).toBe(404);
    expect(creatorFindUniqueMock).toHaveBeenCalledTimes(1);
  });
});

describe("analytics query schemas", () => {
  it("DaysQuery accepts 1–365 and defaults to 30", () => {
    expect(DaysQuery.parse(undefined)).toBe(30);
    expect(DaysQuery.parse("1")).toBe(1);
    expect(DaysQuery.parse("365")).toBe(365);
    expect(DaysQuery.safeParse("0").success).toBe(false);
    expect(DaysQuery.safeParse("366").success).toBe(false);
  });

  it("LimitQuery accepts 1–100 and defaults to 10", () => {
    expect(LimitQuery.parse(undefined)).toBe(10);
    expect(LimitQuery.parse("1")).toBe(1);
    expect(LimitQuery.parse("100")).toBe(100);
    expect(LimitQuery.safeParse("0").success).toBe(false);
    expect(LimitQuery.safeParse("101").success).toBe(false);
  });

  it("RecentQuery bounds the limit and requires a non-empty cursor", () => {
    expect(RecentQuery.parse({})).toEqual({
      limit: RECENT_TIPS_DEFAULT_LIMIT,
    });
    expect(
      RecentQuery.parse({ limit: String(RECENT_TIPS_MAX_LIMIT), cursor: "x" }),
    ).toEqual({ limit: RECENT_TIPS_MAX_LIMIT, cursor: "x" });
    expect(RecentQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(
      RecentQuery.safeParse({ limit: String(RECENT_TIPS_MAX_LIMIT + 1) })
        .success,
    ).toBe(false);
    expect(RecentQuery.safeParse({ cursor: "" }).success).toBe(false);
  });
});
