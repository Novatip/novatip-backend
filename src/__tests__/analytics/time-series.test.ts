/**
 * UTC-day window and gap filling for creator analytics time series.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

interface QueryRow {
  date: Date;
  tipCount: bigint;
  amountRaw: string;
}

interface Point {
  date: string;
  tipCount: number;
  amountRaw: string;
}

let queryRows: QueryRow[] = [];
let cachedValue: Point[] | null = null;

const queryRaw = jest.fn(
  async (..._args: unknown[]): Promise<QueryRow[]> => queryRows,
);
const cacheGet = jest.fn(async (): Promise<Point[] | null> => cachedValue);
const cacheSet = jest.fn(async (): Promise<void> => undefined);

jest.unstable_mockModule("../../db.js", () => ({
  db: { $queryRaw: queryRaw },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet,
  cacheSet,
  cacheInvalidate: async (): Promise<void> => undefined,
}));

const { getTimeSeries } =
  await import("../../modules/analytics/analytics.service.js");

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-03-01T17:45:00.000Z"));
  queryRows = [];
  cachedValue = null;
  queryRaw.mockClear();
  cacheGet.mockClear();
  cacheSet.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("getTimeSeries", () => {
  it("returns today as the only point when days is 1", async () => {
    queryRows = [
      {
        date: new Date("2026-03-01T00:00:00.000Z"),
        tipCount: 2n,
        amountRaw: "25000000",
      },
    ];

    await expect(getTimeSeries("creator-1", 1)).resolves.toEqual([
      {
        date: "2026-03-01",
        tipCount: 2,
        amountRaw: "25000000",
      },
    ]);
    expect(queryRaw.mock.calls[0]?.[2]).toEqual(
      new Date("2026-03-01T00:00:00.000Z"),
    );
  });

  it("crosses a month boundary and leap day with zero-filled gaps", async () => {
    jest.setSystemTime(new Date("2024-03-02T23:59:59.000Z"));
    queryRows = [
      {
        date: new Date("2024-02-29T00:00:00.000Z"),
        tipCount: 3n,
        amountRaw: "30000000",
      },
      {
        date: new Date("2024-03-02T00:00:00.000Z"),
        tipCount: 1n,
        amountRaw: "5000000",
      },
    ];

    await expect(getTimeSeries("creator-1", 4)).resolves.toEqual([
      { date: "2024-02-28", tipCount: 0, amountRaw: "0" },
      { date: "2024-02-29", tipCount: 3, amountRaw: "30000000" },
      { date: "2024-03-01", tipCount: 0, amountRaw: "0" },
      { date: "2024-03-02", tipCount: 1, amountRaw: "5000000" },
    ]);
    expect(queryRaw.mock.calls[0]?.[2]).toEqual(
      new Date("2024-02-28T00:00:00.000Z"),
    );
  });

  it("defaults to 30 UTC days and anchors windowStart to UTC midnight", async () => {
    // 2026-03-30T23:59:59.999Z -> UTC day 2026-03-30; 30-day window starts 2026-03-01T00:00:00.000Z
    jest.setSystemTime(new Date("2026-03-30T23:59:59.999Z"));
    queryRows = [
      {
        date: new Date("2026-03-01T00:00:00.000Z"),
        tipCount: 1n,
        amountRaw: "1000000",
      },
      {
        date: new Date("2026-03-30T00:00:00.000Z"),
        tipCount: 2n,
        amountRaw: "2000000",
      },
    ];

    const series = await getTimeSeries("creator-1");

    expect(series).toHaveLength(30);
    expect(series[0]).toEqual({
      date: "2026-03-01",
      tipCount: 1,
      amountRaw: "1000000",
    });
    expect(series[1]).toEqual({
      date: "2026-03-02",
      tipCount: 0,
      amountRaw: "0",
    });
    expect(series[29]).toEqual({
      date: "2026-03-30",
      tipCount: 2,
      amountRaw: "2000000",
    });
    expect(queryRaw.mock.calls[0]?.[2]).toEqual(
      new Date("2026-03-01T00:00:00.000Z"),
    );
    expect(cacheGet).toHaveBeenCalledWith("analytics:timeseries:creator-1:30");
  });

  it("returns a cached series as is without querying", async () => {
    cachedValue = [{ date: "2026-03-01", tipCount: 7, amountRaw: "70000000" }];

    const result = await getTimeSeries("creator-1", 1);

    expect(result).toBe(cachedValue);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("clamps out-of-range days and floors floats before querying", async () => {
    const zero = await getTimeSeries("creator-1", 0);
    expect(zero).toHaveLength(1);
    expect(queryRaw.mock.calls[0]?.[2]).toEqual(
      new Date("2026-03-01T00:00:00.000Z"),
    );

    const negative = await getTimeSeries("creator-1", -5);
    expect(negative).toHaveLength(1);
    expect(queryRaw.mock.calls[1]?.[2]).toEqual(
      new Date("2026-03-01T00:00:00.000Z"),
    );

    const overMax = await getTimeSeries("creator-1", 500);
    expect(overMax).toHaveLength(365);
    expect(cacheGet).toHaveBeenLastCalledWith(
      "analytics:timeseries:creator-1:365",
    );

    const floated = await getTimeSeries("creator-1", 4.9);
    expect(floated).toHaveLength(4);
    expect(queryRaw.mock.calls[3]?.[2]).toEqual(
      new Date("2026-02-26T00:00:00.000Z"),
    );

    const inRange = await getTimeSeries("creator-1", 14);
    expect(inRange).toHaveLength(14);
    expect(cacheGet).toHaveBeenLastCalledWith(
      "analytics:timeseries:creator-1:14",
    );
  });

  it("falls back to 30 days for NaN, Infinity, null, and handles numeric strings", async () => {
    const nanSeries = await getTimeSeries("creator-1", Number.NaN);
    expect(nanSeries).toHaveLength(30);
    expect(cacheGet).toHaveBeenLastCalledWith(
      "analytics:timeseries:creator-1:30",
    );

    const infSeries = await getTimeSeries("creator-1", Number.POSITIVE_INFINITY);
    expect(infSeries).toHaveLength(30);

    const negInfSeries = await getTimeSeries(
      "creator-1",
      Number.NEGATIVE_INFINITY,
    );
    expect(negInfSeries).toHaveLength(30);

    const nullSeries = await getTimeSeries(
      "creator-1",
      null as unknown as number,
    );
    expect(nullSeries).toHaveLength(30);

    const strSeries = await getTimeSeries(
      "creator-1",
      "7" as unknown as number,
    );
    expect(strSeries).toHaveLength(7);
    expect(cacheGet).toHaveBeenLastCalledWith(
      "analytics:timeseries:creator-1:7",
    );
  });
});
