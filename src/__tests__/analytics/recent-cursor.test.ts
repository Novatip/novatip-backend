/**
 * __tests__/analytics/recent-cursor.test.ts
 *
 * Covers cursor paging on the recent-tips feed.
 *
 * The regression under test: GET /analytics/recent took a limit capped at 100
 * and always returned the newest tips, so a creator with more than a hundred
 * tips could not reach their earlier history through the API at all. The
 * replacement has to page further back *and* stay stable while the feed grows
 * at the head — an offset page shifts by one for every tip indexed mid-scroll,
 * showing the client one row twice and hiding the row it displaced.
 *
 * db and redis are mocked so this runs without PostgreSQL or Redis. The fake
 * findMany implements the slice of Prisma's semantics the service relies on
 * (the ledgerAt/key OR filter, the two-column ordering, take) against an
 * in-memory array, so the paging loop below exercises the real query the
 * service builds rather than a restatement of it.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR = "creator_1";

interface Row {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  message: string;
  ledgerAt: Date;
  creatorId: string;
}

/** The table under the fake client, newest first is *not* assumed. */
let rows: Row[] = [];

function makeRow(n: number, ledgerAtMs: number): Row {
  return {
    id: `tip_${String(n).padStart(4, "0")}`,
    txHash: `hash_${String(n).padStart(4, "0")}`,
    fromAddress: `GSENDER${n}`,
    amount: String(n * 1_000_000),
    message: `tip ${n}`,
    ledgerAt: new Date(ledgerAtMs),
    creatorId: CREATOR,
  };
}

// ── A minimal stand-in for the one query the service issues ──────────────────

type Where = {
  creatorId: string;
  OR?: Array<Record<string, unknown>>;
};

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

function compare(a: Row, b: Row, keyField: "id" | "txHash"): number {
  const byTime = b.ledgerAt.getTime() - a.ledgerAt.getTime();
  if (byTime !== 0) return byTime;
  return a[keyField] < b[keyField] ? 1 : a[keyField] > b[keyField] ? -1 : 0;
}

const findMany = jest.fn(
  async (args: {
    where: Where;
    orderBy: Array<Record<string, string>>;
    take: number;
    select: Record<string, boolean>;
  }): Promise<Row[]> => {
    const keyField =
      args.orderBy[1] && "txHash" in args.orderBy[1] ? "txHash" : "id";

    return rows
      .filter((row) => matches(row, args.where))
      .sort((a, b) => compare(a, b, keyField))
      .slice(0, args.take);
  },
);

jest.unstable_mockModule("../../db.js", () => ({
  db: { tip: { findMany } },
  disconnectDb: async (): Promise<void> => undefined,
}));

// A cache that always misses keeps the paging assertions about the query
// rather than about what a previous test left behind. The keys it is asked for
// are recorded so the cursor's presence in them can be checked.
const cacheKeys: string[] = [];

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: async (key: string): Promise<null> => {
    cacheKeys.push(key);
    return null;
  },
  cacheSet: async (): Promise<void> => undefined,
  cacheInvalidate: async (): Promise<void> => undefined,
}));

const { encodeTipCursor, decodeTipCursor } =
  await import("../../modules/analytics/cursor.js");
const { getRecentTips, toRecentTipsPage, RECENT_TIPS_MAX_LIMIT } =
  await import("../../modules/analytics/analytics.service.js");

beforeEach(() => {
  rows = [];
  cacheKeys.length = 0;
  findMany.mockClear();
});

// ── The cursor encoding ───────────────────────────────────────────────────────

describe("tip cursors", () => {
  it("round-trips a boundary row", () => {
    const ledgerAt = new Date("2026-03-04T05:06:07.008Z");
    const decoded = decodeTipCursor(encodeTipCursor(ledgerAt, "tip_0042"));

    expect(decoded.ledgerAt.toISOString()).toBe(ledgerAt.toISOString());
    expect(decoded.key).toBe("tip_0042");
  });

  it("is opaque — not a value a client would compose by hand", () => {
    const encoded = encodeTipCursor(new Date("2026-03-04T05:06:07.008Z"), "x");
    expect(encoded).not.toContain("2026");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  describe("rejects a cursor this server did not issue", () => {
    const bad: Array<[string, string]> = [
      ["an empty string", ""],
      ["whitespace", "   "],
      ["arbitrary text", "not-a-cursor"],
      [
        "a missing separator",
        Buffer.from("2026-03-04T05:06:07.008Z").toString("base64url"),
      ],
      [
        "an unparseable timestamp",
        Buffer.from("never|tip_1").toString("base64url"),
      ],
      [
        "an empty tiebreaker",
        Buffer.from("2026-03-04T05:06:07.008Z|").toString("base64url"),
      ],
      [
        "a truncated timestamp",
        Buffer.from("2026-03-04|tip_1").toString("base64url"),
      ],
    ];

    test.each(bad)("rejects %s", (_label, raw) => {
      expect(() => decodeTipCursor(raw)).toThrow();
    });

    test.each(bad)("rejects %s with a 400, not a 500", (_label, raw) => {
      // The value reaches a WHERE clause. A half-parsed cursor would page
      // from the wrong place silently; an unhandled throw would read as a
      // server fault to the client.
      try {
        decodeTipCursor(raw);
        throw new Error("expected decodeTipCursor to throw");
      } catch (err) {
        expect(err).toHaveProperty("statusCode", 400);
      }
    });
  });
});

// ── Page arithmetic ───────────────────────────────────────────────────────────

describe("toRecentTipsPage", () => {
  const three = [makeRow(3, 3_000), makeRow(2, 2_000), makeRow(1, 1_000)];

  it("issues no cursor when the page is the end of the feed", () => {
    // Exactly `take` rows came back, so the lookahead row does not exist and
    // there is nothing after this page.
    expect(toRecentTipsPage(three, 3).nextCursor).toBeNull();
  });

  it("issues no cursor for an empty feed", () => {
    expect(toRecentTipsPage([], 20)).toEqual({ tips: [], nextCursor: null });
  });

  it("drops the lookahead row rather than returning take + 1", () => {
    const page = toRecentTipsPage(three, 2);
    expect(page.tips).toHaveLength(2);
    expect(page.tips.map((t) => t.id)).toEqual(["tip_0003", "tip_0002"]);
  });

  it("points the cursor at the last row of the page, not the lookahead", () => {
    const page = toRecentTipsPage(three, 2);
    expect(decodeTipCursor(page.nextCursor as string).key).toBe("tip_0002");
  });

  it("renders ledgerAt as an ISO string on both the cached and live paths", () => {
    // A Date does not survive a round trip through Redis, so the service
    // normalises rather than letting the two paths disagree.
    expect(toRecentTipsPage(three, 3).tips[0]?.ledgerAt).toBe(
      new Date(3_000).toISOString(),
    );
  });
});

// ── Paging through the feed ───────────────────────────────────────────────────

describe("getRecentTips", () => {
  /** Walk every page, following nextCursor until it is null. */
  async function pageThrough(
    limit: number,
    onPage?: (pageIndex: number) => void,
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pageIndex = 0;

    // Bounded so a cursor that fails to advance fails the test rather than
    // hanging the suite.
    for (let guard = 0; guard < 100; guard++) {
      const page = await getRecentTips(CREATOR, limit, cursor);
      seen.push(...page.tips.map((tip) => tip.id));
      onPage?.(pageIndex++);
      if (page.nextCursor === null) return seen;
      cursor = page.nextCursor;
    }

    throw new Error("paging did not terminate");
  }

  it("reaches history past the old 100-row ceiling", async () => {
    // The whole point of the issue: 250 tips were unreachable past the first
    // hundred, however the client set ?limit=.
    rows = Array.from({ length: 250 }, (_, i) =>
      makeRow(250 - i, (250 - i) * 1_000),
    );

    const seen = await pageThrough(100);

    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(seen[0]).toBe("tip_0250");
    expect(seen[249]).toBe("tip_0001");
  });

  it("returns pages newest first", async () => {
    rows = Array.from({ length: 5 }, (_, i) => makeRow(i + 1, (i + 1) * 1_000));

    const page = await getRecentTips(CREATOR, 3, null);
    expect(page.tips.map((t) => t.id)).toEqual([
      "tip_0005",
      "tip_0004",
      "tip_0003",
    ]);
  });

  it("stays stable when tips arrive mid-scroll", async () => {
    rows = Array.from({ length: 20 }, (_, i) =>
      makeRow(i + 1, (i + 1) * 1_000),
    );

    // A new tip lands at the head after the first page is served — exactly
    // the case offset paging got wrong.
    const seen = await pageThrough(5, (pageIndex) => {
      if (pageIndex === 0) rows.push(makeRow(99, 99_000));
    });

    // No row is served twice and nothing is skipped: the pages after the
    // insertion still walk tip_0015 down to tip_0001 in order.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      Array.from(
        { length: 20 },
        (_, i) => `tip_${String(20 - i).padStart(4, "0")}`,
      ),
    );
    // The new arrival sorts before the cursor already handed out, so it is
    // simply not in this scroll — it is on the next request to the head.
    expect(seen).not.toContain("tip_0099");
  });

  it("does not repeat or skip rows sharing a ledger close time", async () => {
    // ledgerAt is not unique, so a page boundary can land inside a group of
    // tips with the same close time. Without the id tiebreaker the rest of
    // the group would be repeated or dropped.
    rows = Array.from({ length: 7 }, (_, i) => makeRow(i + 1, 5_000));

    const seen = await pageThrough(2);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("clamps a page size past the maximum", async () => {
    rows = Array.from({ length: 150 }, (_, i) =>
      makeRow(i + 1, (i + 1) * 1_000),
    );

    const page = await getRecentTips(CREATOR, 5_000, null);

    expect(page.tips).toHaveLength(RECENT_TIPS_MAX_LIMIT);
    expect(page.nextCursor).not.toBeNull();
  });

  it("keys the cache per cursor, so page two is not served page one", async () => {
    rows = Array.from({ length: 10 }, (_, i) =>
      makeRow(i + 1, (i + 1) * 1_000),
    );

    const first = await getRecentTips(CREATOR, 4, null);
    await getRecentTips(CREATOR, 4, first.nextCursor);

    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
    expect(cacheKeys[1]).toContain(first.nextCursor as string);
  });

  it("rejects a malformed cursor before it reaches the database", async () => {
    await expect(getRecentTips(CREATOR, 20, "not-a-cursor")).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });
});
