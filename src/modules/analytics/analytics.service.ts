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
import { cursorFilter, decodeTipCursor, encodeTipCursor } from "./cursor.js";

const CACHE_TTL = 30; // seconds

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TipTotals {
  totalTips: number;
  totalAmountRaw: string; // sum as string (i128 precision)
  uniqueSupporters: number;
}

export interface TimeSeriesPoint {
  date: string; // YYYY-MM-DD
  tipCount: number;
  amountRaw: string;
}

export interface TopSupporter {
  fromAddress: string;
  tipCount: number;
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
    totalTips: Number(row?.totalTips ?? 0n),
    totalAmountRaw: row?.totalAmountRaw ?? "0",
    uniqueSupporters: Number(row?.uniqueSupporters ?? 0n),
  };

  await cacheSet(key, result, CACHE_TTL);
  return result;
}

// ── Time series ───────────────────────────────────────────────────────────────

interface TimeSeriesRow {
  date: Date;
  tipCount: bigint;
  amountRaw: string;
}

/**
 * Midnight UTC for the given instant, as a Date.
 * "ledgerAt" is stored as TIMESTAMP(3) with no time zone, and Prisma reads/
 * writes those naive values as UTC — so anchoring the window to UTC days here
 * keeps this in lockstep with the date_trunc('day', "ledgerAt") grouping below.
 */
function utcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
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
      tipCount: Number(row.tipCount),
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
      tipCount: point?.tipCount ?? 0,
      amountRaw: point?.amountRaw ?? "0",
    });
  }

  await cacheSet(key, result, CACHE_TTL);
  return result;
}

// ── Top supporters ────────────────────────────────────────────────────────────

interface TopSupporterRow {
  fromAddress: string;
  tipCount: bigint;
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
    fromAddress: row.fromAddress,
    tipCount: Number(row.tipCount),
    totalAmountRaw: row.totalAmountRaw,
  }));

  await cacheSet(key, result, CACHE_TTL);
  return result;
}

// ── Recent tips ───────────────────────────────────────────────────────────────

export interface RecentTip {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: string; // stroops as string (i128 precision)
  message: string;
  /**
   * Ledger close time as an ISO 8601 string rather than a Date. Over the wire
   * these were always ISO strings — JSON has no date type — but the cached and
   * uncached paths disagreed on the in-process type, since a Date does not
   * survive a round trip through Redis. Normalising here makes the two paths
   * return the same thing.
   */
  ledgerAt: string;
}

export interface RecentTipsPage {
  tips: RecentTip[];
  /**
   * Opaque cursor for the following page, or null when this page is the end of
   * the feed. Clients echo it back as ?cursor= and do not parse it.
   */
  nextCursor: string | null;
}

/** Largest page the recent-tips feed will return, whatever the caller asks for. */
export const RECENT_TIPS_MAX_LIMIT = 100;

/** Page size used when the caller does not ask for one. */
export const RECENT_TIPS_DEFAULT_LIMIT = 20;

/**
 * One page of a creator's tips, newest first.
 *
 * Paging is by cursor, not offset. The feed grows at the head, so an offset
 * page would shift by one for every tip indexed mid-scroll: the client would
 * see a row twice and never see the row it displaced. The cursor names the row
 * the previous page ended on, so a new arrival at the head cannot move a
 * boundary that has already been handed out.
 *
 * A tip indexed between two requests is simply not in the pages already
 * served; it appears on a later page only if it sorts after the cursor
 * (possible for a tip sharing a ledger close time with the boundary row). It
 * is never a duplicate and never displaces an unseen row.
 *
 * `limit` is clamped to RECENT_TIPS_MAX_LIMIT here as well as at the route, so
 * a direct caller cannot ask for an unbounded page.
 */
export async function getRecentTips(
  creatorId: string,
  limit = RECENT_TIPS_DEFAULT_LIMIT,
  cursor?: string | null,
): Promise<RecentTipsPage> {
  const take = Math.min(Math.max(limit, 1), RECENT_TIPS_MAX_LIMIT);

  // Decoded before the cache read so a malformed cursor is a 400 either way.
  const after = cursor ? decodeTipCursor(cursor) : null;

  const key = `analytics:recent:${creatorId}:${take}:${cursor ?? "head"}`;
  const cached = await cacheGet<RecentTipsPage>(key);
  if (cached) return cached;

  // One extra row is fetched purely to learn whether another page exists; it
  // is dropped before the response so the page is never over `take`.
  const rows = await db.tip.findMany({
    where: { creatorId, ...(after ? cursorFilter(after, "id") : {}) },
    orderBy: [{ ledgerAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      txHash: true,
      fromAddress: true,
      amount: true,
      message: true,
      ledgerAt: true,
    },
  });

  const result = toRecentTipsPage(rows, take);

  // Short TTL keeps the live feed responsive; the dashboard polls every 15 s.
  await cacheSet(key, result, CACHE_TTL);
  return result;
}

/**
 * Trim the lookahead row and derive the next cursor.
 *
 * Exported for tests: the page/cursor arithmetic is the part that is easy to
 * get off by one, and it needs no database to exercise.
 */
export function toRecentTipsPage(
  rows: Array<{
    id: string;
    txHash: string;
    fromAddress: string;
    amount: string;
    message: string;
    ledgerAt: Date;
  }>,
  take: number,
): RecentTipsPage {
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page[page.length - 1];

  return {
    tips: page.map((row) => ({
      id: row.id,
      txHash: row.txHash,
      fromAddress: row.fromAddress,
      amount: row.amount,
      message: row.message,
      ledgerAt: row.ledgerAt.toISOString(),
    })),
    // A cursor is only issued when there is something after it, so a client
    // paging to the end gets null and stops rather than making one more
    // request that comes back empty.
    nextCursor:
      hasMore && last ? encodeTipCursor(last.ledgerAt, last.id) : null,
  };
}
