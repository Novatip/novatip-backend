/**
 * __tests__/analytics/public-recent.test.ts
 *
 * Covers the unauthenticated public tips feed.
 *
 * The gap it closes: every analytics route sits behind app.authenticate, so a
 * creator's recent tips could only be read with that creator's own token — the
 * public tip page had no way to show a supporter feed to a visitor with no
 * account. The risk in closing it is over-exposure, so the assertions here are
 * mostly about what the response does *not* contain: the tip's row id and the
 * creator's id are internal to this database, while the sender, amount,
 * message and ledger time are already public on chain.
 *
 * db, redis and the creator lookup are mocked so this runs without
 * PostgreSQL or Redis.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const SLUG = "alice";
const CREATOR_ID = "creator_internal_id";

interface Row {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  message: string;
  ledgerAt: Date;
  creatorId: string;
}

let rows: Row[] = [];

function makeRow(n: number, ledgerAtMs: number): Row {
  return {
    id: `tip_${String(n).padStart(4, "0")}`,
    txHash: `hash_${String(n).padStart(4, "0")}`,
    fromAddress: `GSENDER${n}`,
    amount: String(n * 1_000_000),
    message: `tip ${n}`,
    ledgerAt: new Date(ledgerAtMs),
    creatorId: CREATOR_ID,
  };
}

type Where = { creatorId: string; OR?: Array<Record<string, unknown>> };

function matches(row: Row, where: Where): boolean {
  if (row.creatorId !== where.creatorId) return false;
  if (!where.OR) return true;

  return where.OR.some((clause) =>
    Object.entries(clause).every(([field, condition]) => {
      const value = row[field as keyof Row];
      if (condition instanceof Date) {
        return (value as Date).getTime() === condition.getTime();
      }
      const lt = (condition as { lt?: unknown }).lt;
      if (lt instanceof Date) return (value as Date).getTime() < lt.getTime();
      return String(value) < String(lt);
    }),
  );
}

/** Honour the query's `select` so a widened select would show up here. */
function project(row: Row, select: Record<string, boolean>): Partial<Row> {
  const out: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) out[field] = row[field as keyof Row];
  }
  return out as Partial<Row>;
}

const findMany = jest.fn(
  async (args: {
    where: Where;
    orderBy: Array<Record<string, string>>;
    take: number;
    select: Record<string, boolean>;
  }): Promise<Partial<Row>[]> =>
    rows
      .filter((row) => matches(row, args.where))
      .sort((a, b) => {
        const byTime = b.ledgerAt.getTime() - a.ledgerAt.getTime();
        if (byTime !== 0) return byTime;
        return a.txHash < b.txHash ? 1 : a.txHash > b.txHash ? -1 : 0;
      })
      .slice(0, args.take)
      .map((row) => project(row, args.select)),
);

jest.unstable_mockModule("../../db.js", () => ({
  db: { tip: { findMany } },
  disconnectDb: async (): Promise<void> => undefined,
}));

const cache = new Map<string, unknown>();
const cacheWrites: Array<{ key: string; ttl: number }> = [];

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: async (key: string): Promise<unknown> => cache.get(key) ?? null,
  cacheSet: async (key: string, value: unknown, ttl: number): Promise<void> => {
    cacheWrites.push({ key, ttl });
    // Round-tripped through JSON like the real cache, so a value that only
    // survives in-process would fail here.
    cache.set(key, JSON.parse(JSON.stringify(value)));
  },
  cacheInvalidate: async (): Promise<void> => undefined,
}));

/** Unknown slugs 404 out of getCreatorBySlug, as they do for the resolver. */
const getCreatorBySlug = jest.fn(async (slug: string) => {
  if (slug !== SLUG) {
    throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
  }
  return { id: CREATOR_ID, slug };
});

jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug,
}));

const {
  getPublicRecentTips,
  toPublicTipsPage,
  PUBLIC_TIPS_MAX_LIMIT,
  PUBLIC_TIPS_DEFAULT_LIMIT,
  PUBLIC_TIPS_CACHE_SECONDS,
} = await import("../../modules/analytics/analytics.service.js");
const { decodeTipCursor } = await import("../../modules/analytics/cursor.js");

beforeEach(() => {
  rows = Array.from({ length: 5 }, (_, i) => makeRow(i + 1, (i + 1) * 1_000));
  cache.clear();
  cacheWrites.length = 0;
  findMany.mockClear();
  getCreatorBySlug.mockClear();
});

// ── What the response exposes ─────────────────────────────────────────────────

describe("the public tip shape", () => {
  it("exposes only fields already public on chain", async () => {
    const page = await getPublicRecentTips(SLUG, 1);

    expect(Object.keys(page.tips[0] as object).sort()).toEqual([
      "amount",
      "fromAddress",
      "ledgerAt",
      "message",
      "txHash",
    ]);
  });

  it("omits the tip's row id and the creator's id", async () => {
    const page = await getPublicRecentTips(SLUG, 5);

    for (const tip of page.tips) {
      expect(tip).not.toHaveProperty("id");
      expect(tip).not.toHaveProperty("creatorId");
    }
  });

  it("never selects those columns in the first place", async () => {
    // Not just stripped on the way out: a column that is never read cannot
    // leak through the Redis cache either.
    await getPublicRecentTips(SLUG, 5);

    const select = findMany.mock.calls[0]?.[0].select ?? {};
    expect(select).not.toHaveProperty("id");
    expect(select).not.toHaveProperty("creatorId");
  });

  it("keeps the amount as a string rather than a number", async () => {
    // Stroops are i128 on chain; a float would lose precision silently.
    const page = await getPublicRecentTips(SLUG, 1);
    expect(typeof page.tips[0]?.amount).toBe("string");
  });

  it("renders ledgerAt as ISO 8601", async () => {
    const page = await getPublicRecentTips(SLUG, 1);
    expect(page.tips[0]?.ledgerAt).toBe(new Date(5_000).toISOString());
  });
});

// ── Page bounds ───────────────────────────────────────────────────────────────

describe("page size", () => {
  it("defaults to a bounded page", async () => {
    rows = Array.from({ length: 80 }, (_, i) =>
      makeRow(i + 1, (i + 1) * 1_000),
    );
    const page = await getPublicRecentTips(SLUG);
    expect(page.tips).toHaveLength(PUBLIC_TIPS_DEFAULT_LIMIT);
  });

  it("clamps an anonymous caller asking for the whole history", async () => {
    rows = Array.from({ length: 500 }, (_, i) =>
      makeRow(i + 1, (i + 1) * 1_000),
    );

    const page = await getPublicRecentTips(SLUG, 10_000);

    expect(page.tips).toHaveLength(PUBLIC_TIPS_MAX_LIMIT);
    expect(page.nextCursor).not.toBeNull();
  });

  it("is capped lower than the authenticated dashboard feed", async () => {
    const { RECENT_TIPS_MAX_LIMIT } =
      await import("../../modules/analytics/analytics.service.js");
    expect(PUBLIC_TIPS_MAX_LIMIT).toBeLessThan(RECENT_TIPS_MAX_LIMIT);
  });
});

// ── Paging ────────────────────────────────────────────────────────────────────

describe("paging", () => {
  it("keys the cursor on the transaction hash, which is public on chain", () => {
    const page = toPublicTipsPage(
      [makeRow(3, 3_000), makeRow(2, 2_000), makeRow(1, 1_000)],
      2,
    );
    expect(decodeTipCursor(page.nextCursor as string).key).toBe("hash_0002");
  });

  it("walks the whole history without repeats", async () => {
    rows = Array.from({ length: 23 }, (_, i) =>
      makeRow(i + 1, (i + 1) * 1_000),
    );

    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 50; guard++) {
      const page: Awaited<ReturnType<typeof getPublicRecentTips>> =
        await getPublicRecentTips(SLUG, 5, cursor);
      seen.push(...page.tips.map((tip) => tip.txHash));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });

  it("rejects a cursor this server did not issue", async () => {
    await expect(getPublicRecentTips(SLUG, 20, "nonsense")).rejects.toThrow(
      /Invalid cursor/,
    );
  });
});

// ── Slug resolution and caching ───────────────────────────────────────────────

describe("slug resolution", () => {
  it("resolves the creator by public slug", async () => {
    await getPublicRecentTips(SLUG, 5);
    expect(getCreatorBySlug).toHaveBeenCalledWith(SLUG);
  });

  it("404s an unknown slug rather than returning an empty feed", async () => {
    // An empty feed would be indistinguishable from a creator with no tips.
    await expect(getPublicRecentTips("nobody", 5)).rejects.toHaveProperty(
      "statusCode",
      404,
    );
  });
});

describe("caching", () => {
  it("caches the page", async () => {
    await getPublicRecentTips(SLUG, 5);

    expect(cacheWrites).toHaveLength(1);
    expect(cacheWrites[0]?.ttl).toBe(PUBLIC_TIPS_CACHE_SECONDS);
  });

  it("serves a repeat request from the cache without touching the database", async () => {
    const first = await getPublicRecentTips(SLUG, 5);
    findMany.mockClear();

    const second = await getPublicRecentTips(SLUG, 5);

    expect(second).toEqual(first);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("keys the cache per slug, so one creator's feed is not served for another", async () => {
    await getPublicRecentTips(SLUG, 5);
    expect(cacheWrites[0]?.key).toContain(SLUG);
  });
});
