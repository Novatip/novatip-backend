/**
 * analytics.service.ts
 *
 * Analytics queries for creator dashboards.
 * All queries are scoped to a single creator by their DB id.
 *
 * Results are cached in Redis to avoid hammering PostgreSQL on
 * every dashboard refresh.
 */

import { db } from "../../db.js";
import { cacheGet, cacheSet } from "../../redis.js";

const CACHE_TTL = 30; // seconds

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TipTotals {
  totalTips:      number;
  totalAmountRaw: string;   // sum as string (i128 precision)
  uniqueSupporters: number;
}

export interface TimeSeriesPoint {
  date:      string;   // YYYY-MM-DD
  tipCount:  number;
  amountRaw: string;
}

export interface TopSupporter {
  fromAddress:  string;
  tipCount:     number;
  totalAmountRaw: string;
}

// ── Totals ────────────────────────────────────────────────────────────────────

interface TotalsRow {
  totalTips: bigint;
  totalAmountRaw: string | null;
  uniqueSupporters: bigint;
}

/**
 * Total tip count, total USDC received (stroops), and unique supporter count.
 *
 * amount is stored as a String to preserve i128 precision, so the sum is
 * computed by casting to numeric in SQL rather than in JS — this both
 * avoids loading every row and keeps full precision (Postgres numeric is
 * arbitrary-precision, unlike a JS number).
 */
export async function getTotals(creatorId: string): Promise<TipTotals> {
  const key = `analytics:totals:${creatorId}`;
  const cached = await cacheGet<TipTotals>(key);
  if (cached) return cached;

  const rows = await db.$queryRaw<TotalsRow[]>`
    SELECT
      COUNT(*)                                AS "totalTips",
      COALESCE(SUM(amount::numeric), 0)::text AS "totalAmountRaw",
      COUNT(DISTINCT "fromAddress")            AS "uniqueSupporters"
    FROM "Tip"
    WHERE "creatorId" = ${creatorId}
  `;
  const row = rows[0];

  const result: TipTotals = {
    totalTips:        Number(row?.totalTips ?? 0n),
    totalAmountRaw:   row?.totalAmountRaw ?? "0",
    uniqueSupporters: Number(row?.uniqueSupporters ?? 0n),
  };

  await cacheSet(key, result, CACHE_TTL);
  return result;
}

// ── Time series ───────────────────────────────────────────────────────────────

interface TimeSeriesRow {
  date:      Date;
  tipCount:  bigint;
  amountRaw: string;
}

/**
 * Midnight UTC for the given instant, as a Date.
 * "ledgerAt" is stored as TIMESTAMP(3) with no time zone, and Prisma reads/
 * writes those naive values as UTC — so anchoring the window to UTC days here
 * keeps this in lockstep with the date_trunc('day', "ledgerAt") grouping below.
 */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Daily tip counts and amounts over the last N days.
 * Default window: 30 days.
 *
 * Days are UTC calendar days (00:00–23:59:59 UTC), not the caller's local
 * days — see utcMidnight() above. The window always returns exactly `days`
 * points, oldest first, one per UTC day up to and including today; days with
 * no tips are filled in with tipCount: 0 and amountRaw: "0" rather than
 * omitted.
 */
export async function getTimeSeries(
  creatorId: string,
  days = 30,
): Promise<TimeSeriesPoint[]> {
  const key = `analytics:timeseries:${creatorId}:${days}`;
  const cached = await cacheGet<TimeSeriesPoint[]>(key);
  if (cached) return cached;

  const today = utcMidnight(new Date());
  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - (days - 1));

  const rows = await db.$queryRaw<TimeSeriesRow[]>`
    SELECT
      date_trunc('day', "ledgerAt") AS "date",
      COUNT(*)                      AS "tipCount",
      SUM(amount::numeric)::text    AS "amountRaw"
    FROM "Tip"
    WHERE "creatorId" = ${creatorId} AND "ledgerAt" >= ${windowStart}
    GROUP BY date_trunc('day', "ledgerAt")
    ORDER BY date_trunc('day', "ledgerAt") ASC
  `;

  const byDate = new Map<string, { tipCount: number; amountRaw: string }>();
  for (const row of rows) {
    byDate.set(row.date.toISOString().slice(0, 10), {
      tipCount:  Number(row.tipCount),
      amountRaw: row.amountRaw,
    });
  }

  const result: TimeSeriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(windowStart);
    day.setUTCDate(day.getUTCDate() + i);
    const date = day.toISOString().slice(0, 10);
    const point = byDate.get(date);

    result.push({
      date,
      tipCount:  point?.tipCount ?? 0,
      amountRaw: point?.amountRaw ?? "0",
    });
  }

  await cacheSet(key, result, CACHE_TTL);
  return result;
}

// ── Top supporters ────────────────────────────────────────────────────────────

interface TopSupporterRow {
  fromAddress:    string;
  tipCount:       bigint;
  totalAmountRaw: string;
}

/**
 * Top N supporters ranked by total amount sent.
 * Default: top 10.
 */
export async function getTopSupporters(
  creatorId: string,
  limit = 10,
): Promise<TopSupporter[]> {
  const key = `analytics:top:${creatorId}:${limit}`;
  const cached = await cacheGet<TopSupporter[]>(key);
  if (cached) return cached;

  const rows = await db.$queryRaw<TopSupporterRow[]>`
    SELECT
      "fromAddress",
      COUNT(*)                   AS "tipCount",
      SUM(amount::numeric)::text AS "totalAmountRaw"
    FROM "Tip"
    WHERE "creatorId" = ${creatorId}
    GROUP BY "fromAddress"
    ORDER BY SUM(amount::numeric) DESC
    LIMIT ${limit}
  `;

  const result: TopSupporter[] = rows.map((row) => ({
    fromAddress:    row.fromAddress,
    tipCount:       Number(row.tipCount),
    totalAmountRaw: row.totalAmountRaw,
  }));

  await cacheSet(key, result, CACHE_TTL);
  return result;
}

// ── Recent tips ───────────────────────────────────────────────────────────────

/**
 * Most recent tips for the live feed on the creator dashboard.
 * Default: last 20.
 */
export async function getRecentTips(creatorId: string, limit = 20) {
  return db.tip.findMany({
    where:   { creatorId },
    orderBy: { ledgerAt: "desc" },
    take:    limit,
    select: {
      id:          true,
      txHash:      true,
      fromAddress: true,
      amount:      true,
      message:     true,
      ledgerAt:    true,
    },
  });
}
