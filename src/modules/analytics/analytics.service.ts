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

/**
 * Total tip count, total USDC received (stroops), and unique supporter count.
 */
export async function getTotals(creatorId: string): Promise<TipTotals> {
  const key = `analytics:totals:${creatorId}`;
  const cached = await cacheGet<TipTotals>(key);
  if (cached) return cached;

  const tips = await db.tip.findMany({
    where: { creatorId },
    select: { amount: true, fromAddress: true },
  });

  const totalTips      = tips.length;
  const totalAmountRaw = tips
    .reduce((sum, t) => sum + BigInt(t.amount), 0n)
    .toString();
  const uniqueSupporters = new Set(tips.map((t) => t.fromAddress)).size;

  const result: TipTotals = { totalTips, totalAmountRaw, uniqueSupporters };
  await cacheSet(key, result, CACHE_TTL);
  return result;
}

// ── Time series ───────────────────────────────────────────────────────────────

/**
 * Daily tip counts and amounts over the last N days.
 * Default window: 30 days.
 */
export async function getTimeSeries(
  creatorId: string,
  days = 30,
): Promise<TimeSeriesPoint[]> {
  const key = `analytics:timeseries:${creatorId}:${days}`;
  const cached = await cacheGet<TimeSeriesPoint[]>(key);
  if (cached) return cached;

  const since = new Date();
  since.setDate(since.getDate() - days);

  const tips = await db.tip.findMany({
    where:   { creatorId, ledgerAt: { gte: since } },
    select:  { ledgerAt: true, amount: true },
    orderBy: { ledgerAt: "asc" },
  });

  // Group by date
  const byDate = new Map<string, { count: number; amount: bigint }>();
  for (const tip of tips) {
    const date = tip.ledgerAt.toISOString().slice(0, 10) as string;
    const existing = byDate.get(date) ?? { count: 0, amount: 0n };
    byDate.set(date, {
      count:  existing.count + 1,
      amount: existing.amount + BigInt(tip.amount),
    });
  }

  const result: TimeSeriesPoint[] = Array.from(byDate.entries()).map(
    ([date, { count, amount }]) => ({
      date,
      tipCount:  count,
      amountRaw: amount.toString(),
    }),
  );

  await cacheSet(key, result, CACHE_TTL);
  return result;
}

// ── Top supporters ────────────────────────────────────────────────────────────

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

  const tips = await db.tip.findMany({
    where:  { creatorId },
    select: { fromAddress: true, amount: true },
  });

  // Aggregate by sender
  const byAddress = new Map<string, { count: number; amount: bigint }>();
  for (const tip of tips) {
    const existing = byAddress.get(tip.fromAddress) ?? { count: 0, amount: 0n };
    byAddress.set(tip.fromAddress, {
      count:  existing.count + 1,
      amount: existing.amount + BigInt(tip.amount),
    });
  }

  const result: TopSupporter[] = Array.from(byAddress.entries())
    .map(([fromAddress, { count, amount }]) => ({
      fromAddress,
      tipCount:       count,
      totalAmountRaw: amount.toString(),
    }))
    .sort((a, b) => {
      const diff = BigInt(b.totalAmountRaw) - BigInt(a.totalAmountRaw);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    })
    .slice(0, limit);

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
