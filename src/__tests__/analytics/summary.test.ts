/**
 * __tests__/analytics/summary.test.ts
 *
 * Unit tests (mocked db/redis) for getTotals and getTopSupporters in
 * analytics.service.ts.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR_ID = "creator-1";

let queryRows: unknown[] = [];
let cachedValue: unknown = null;

const queryRaw = jest.fn(async (..._args: unknown[]) => queryRows);
const cacheGet = jest.fn(async () => cachedValue);
const cacheSet = jest.fn(async () => undefined);

jest.unstable_mockModule("../../db.js", () => ({
  db: { $queryRaw: queryRaw },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: {},
  cacheGet,
  cacheSet,
  cacheInvalidate: async (): Promise<void> => undefined,
}));

const { getTotals, getTopSupporters } =
  await import("../../modules/analytics/analytics.service.js");

beforeEach(() => {
  queryRows = [];
  cachedValue = null;
  queryRaw.mockClear();
  cacheGet.mockClear();
  cacheSet.mockClear();
});

describe("getTotals", () => {
  it("returns zeroes when a creator has no tips", async () => {
    queryRows = [
      {
        totalTips: 0n,
        totalAmountRaw: "0",
        uniqueSupporters: 0n,
      },
    ];

    const result = await getTotals(CREATOR_ID);

    expect(result).toEqual({
      totalTips: 0,
      totalAmountRaw: "0",
      uniqueSupporters: 0,
    });
    expect(cacheGet).toHaveBeenCalledWith(`analytics:totals:${CREATOR_ID}`);
    expect(cacheSet).toHaveBeenCalledWith(
      `analytics:totals:${CREATOR_ID}`,
      result,
      30,
    );
  });

  it("handles an empty row array or null totalAmountRaw gracefully", async () => {
    queryRows = [];

    await expect(getTotals(CREATOR_ID)).resolves.toEqual({
      totalTips: 0,
      totalAmountRaw: "0",
      uniqueSupporters: 0,
    });

    queryRows = [
      {
        totalTips: 0n,
        totalAmountRaw: null,
        uniqueSupporters: 0n,
      },
    ];

    await expect(getTotals(CREATOR_ID)).resolves.toEqual({
      totalTips: 0,
      totalAmountRaw: "0",
      uniqueSupporters: 0,
    });
  });

  it("counts multiple tips from the same supporter as one unique supporter", async () => {
    queryRows = [
      {
        totalTips: 3n,
        totalAmountRaw: "4000000",
        uniqueSupporters: 2n,
      },
    ];

    const result = await getTotals(CREATOR_ID);

    expect(result).toEqual({
      totalTips: 3,
      totalAmountRaw: "4000000",
      uniqueSupporters: 2,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0]?.[1]).toBe(CREATOR_ID);
  });

  it("preserves i128-scale amounts without precision loss", async () => {
    const maxI128 = "170141183460469231731687303715884105727";
    queryRows = [
      {
        totalTips: 1n,
        totalAmountRaw: maxI128,
        uniqueSupporters: 1n,
      },
    ];

    const result = await getTotals(CREATOR_ID);

    expect(result).toEqual({
      totalTips: 1,
      totalAmountRaw: maxI128,
      uniqueSupporters: 1,
    });
  });

  it("returns cached totals without querying the database", async () => {
    const cached = {
      totalTips: 5,
      totalAmountRaw: "50000000",
      uniqueSupporters: 3,
    };
    cachedValue = cached;

    const result = await getTotals(CREATOR_ID);

    expect(result).toBe(cached);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });
});

describe("getTopSupporters", () => {
  it("uses a default limit of 10 and caches under the limit key", async () => {
    queryRows = [
      {
        fromAddress: "GSUPPORTER1",
        tipCount: 4n,
        totalAmountRaw: "90000000",
      },
      {
        fromAddress: "GSUPPORTER2",
        tipCount: 2n,
        totalAmountRaw: "40000000",
      },
    ];

    const result = await getTopSupporters(CREATOR_ID);

    expect(result).toEqual([
      {
        fromAddress: "GSUPPORTER1",
        tipCount: 4,
        totalAmountRaw: "90000000",
      },
      {
        fromAddress: "GSUPPORTER2",
        tipCount: 2,
        totalAmountRaw: "40000000",
      },
    ]);
    expect(cacheGet).toHaveBeenCalledWith(`analytics:top:${CREATOR_ID}:10`);
    expect(queryRaw.mock.calls[0]?.[1]).toBe(CREATOR_ID);
    expect(queryRaw.mock.calls[0]?.[2]).toBe(10);
    expect(cacheSet).toHaveBeenCalledWith(
      `analytics:top:${CREATOR_ID}:10`,
      result,
      30,
    );
  });

  it("orders supporters by descending total amount in SQL", async () => {
    queryRows = [];

    await getTopSupporters(CREATOR_ID, 5);

    const templateStrings = queryRaw.mock.calls[0]?.[0] as
      | TemplateStringsArray
      | undefined;
    const sqlText = templateStrings ? templateStrings.join(" ") : "";
    expect(sqlText).toContain("ORDER BY SUM(amount::numeric) DESC");
    expect(queryRaw.mock.calls[0]?.[2]).toBe(5);
  });

  it("handles empty results, ties, and limit=1 boundary", async () => {
    queryRows = [];
    await expect(getTopSupporters(CREATOR_ID)).resolves.toEqual([]);

    // Ties in totalAmountRaw and i128-scale amounts
    const largeAmount = "170141183460469231731687303715884105727";
    queryRows = [
      {
        fromAddress: "GTIE1",
        tipCount: 2n,
        totalAmountRaw: largeAmount,
      },
      {
        fromAddress: "GTIE2",
        tipCount: 1n,
        totalAmountRaw: largeAmount,
      },
    ];

    const tiedResult = await getTopSupporters(CREATOR_ID, 2);
    expect(tiedResult).toEqual([
      { fromAddress: "GTIE1", tipCount: 2, totalAmountRaw: largeAmount },
      { fromAddress: "GTIE2", tipCount: 1, totalAmountRaw: largeAmount },
    ]);

    // limit = 1 boundary
    queryRows = [
      {
        fromAddress: "GONLYONE",
        tipCount: 1n,
        totalAmountRaw: "10000000",
      },
    ];
    const singleResult = await getTopSupporters(CREATOR_ID, 1);
    expect(singleResult).toHaveLength(1);
    expect(queryRaw.mock.calls[2]?.[2]).toBe(1);
  });

  it("returns cached supporters without querying the database", async () => {
    const cached = [
      { fromAddress: "GCACHED", tipCount: 3, totalAmountRaw: "30000000" },
    ];
    cachedValue = cached;

    const result = await getTopSupporters(CREATOR_ID, 10);

    expect(result).toBe(cached);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });
});
