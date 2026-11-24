/**
 * __tests__/creator/hide-message-cache.test.ts
 *
 * Tests that setTipMessageHidden invalidates both:
 * - the creator's private recent-tips cache (analytics:recent:{creatorId}:*)
 * - the public feed cache across arbitrary limits and cursors
 *   (analytics:public-recent:{slug}:*)
 *
 * db, redis and creator.service are mocked so this runs without PostgreSQL
 * or Redis.
 */

import { jest } from "@jest/globals";
import { encodeTipCursor } from "../../modules/analytics/cursor.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR_ID = "creator_cache_test";
const SLUG = "alice";

interface TipRow {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  message: string;
  messageHidden: boolean;
  ledgerAt: Date;
  creatorId: string;
}

let tips: TipRow[] = [];

function seedTips(): void {
  const baseMs = Date.UTC(2026, 5, 1, 12, 0, 0);
  tips = [
    {
      id: "tip_003",
      txHash: "hash_003",
      fromAddress: "GSENDER3",
      amount: "3000000",
      message: "Newest tip",
      messageHidden: false,
      ledgerAt: new Date(baseMs + 3000),
      creatorId: CREATOR_ID,
    },
    {
      id: "tip_002",
      txHash: "hash_002",
      fromAddress: "GSENDER2",
      amount: "2000000",
      message: "Spam message here!",
      messageHidden: false,
      ledgerAt: new Date(baseMs + 2000),
      creatorId: CREATOR_ID,
    },
    {
      id: "tip_001",
      txHash: "hash_001",
      fromAddress: "GSENDER1",
      amount: "1000000",
      message: "Oldest tip",
      messageHidden: false,
      ledgerAt: new Date(baseMs + 1000),
      creatorId: CREATOR_ID,
    },
  ];
}

function project(
  row: TipRow,
  select: Record<string, boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) out[field] = row[field as keyof TipRow];
  }
  return out;
}

const cache = new Map<string, unknown>();

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: async <T>(key: string): Promise<T | null> =>
    (cache.get(key) as T | undefined) ?? null,
  cacheSet: async (key: string, value: unknown): Promise<void> => {
    cache.set(key, JSON.parse(JSON.stringify(value)));
  },
  cacheInvalidate: async (key: string): Promise<void> => {
    cache.delete(key);
  },
  cacheInvalidatePrefix: async (prefix: string): Promise<void> => {
    for (const key of Array.from(cache.keys())) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  },
}));

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: async (args: { where: { id?: string; slug?: string } }) => {
        if (args.where.id === CREATOR_ID || args.where.slug === SLUG) {
          return { id: CREATOR_ID, slug: SLUG };
        }
        return null;
      },
    },
    tip: {
      updateMany: async (args: {
        where: { id: string; creatorId: string };
        data: { messageHidden: boolean };
      }) => {
        const match = tips.find(
          (t) =>
            t.id === args.where.id && t.creatorId === args.where.creatorId,
        );
        if (!match) return { count: 0 };
        match.messageHidden = args.data.messageHidden;
        return { count: 1 };
      },
      findUnique: async (args: {
        where: { id: string };
        select: Record<string, boolean>;
      }) => {
        const match = tips.find((t) => t.id === args.where.id);
        return match ? project(match, args.select) : null;
      },
      findMany: async (args: {
        where: {
          creatorId: string;
          OR?: Array<Record<string, unknown>>;
        };
        take: number;
        select: Record<string, boolean>;
      }) => {
        const filtered = tips
          .filter((row) => {
            if (row.creatorId !== args.where.creatorId) return false;
            if (!args.where.OR) return true;
            return args.where.OR.some((clause) =>
              Object.entries(clause).every(([field, cond]) => {
                const val = row[field as keyof TipRow];
                if (cond instanceof Date) {
                  return (val as Date).getTime() === cond.getTime();
                }
                const lt = (cond as { lt?: unknown }).lt;
                if (lt instanceof Date) {
                  return (val as Date).getTime() < lt.getTime();
                }
                return String(val) < String(lt);
              }),
            );
          })
          .sort((a, b) => b.ledgerAt.getTime() - a.ledgerAt.getTime());

        return filtered
          .slice(0, args.take)
          .map((row) => project(row, args.select));
      },
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: async (slug: string) => {
    if (slug !== SLUG) {
      throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
    }
    return { id: CREATOR_ID, slug: SLUG };
  },
}));

const { setTipMessageHidden } = await import(
  "../../modules/creator/messages.service.js"
);
const { getRecentTips, getPublicRecentTips } = await import(
  "../../modules/analytics/analytics.service.js"
);

describe("setTipMessageHidden cache invalidation (#253)", () => {
  beforeEach(() => {
    cache.clear();
    seedTips();
  });

  it("invalidates the creator's analytics:recent cache so getRecentTips immediately reflects hide and unhide", async () => {
    const firstPage = await getRecentTips(CREATOR_ID, 20, null);
    expect(firstPage.tips.find((t) => t.id === "tip_002")?.messageHidden).toBe(
      false,
    );

    await setTipMessageHidden(CREATOR_ID, "tip_002", true);

    const afterHide = await getRecentTips(CREATOR_ID, 20, null);
    expect(afterHide.tips.find((t) => t.id === "tip_002")?.messageHidden).toBe(
      true,
    );

    await setTipMessageHidden(CREATOR_ID, "tip_002", false);

    const afterUnhide = await getRecentTips(CREATOR_ID, 20, null);
    expect(
      afterUnhide.tips.find((t) => t.id === "tip_002")?.messageHidden,
    ).toBe(false);
  });

  it("invalidates public feed cache entries for non-default limits and cursors", async () => {
    const newest = tips[0]!;
    const cursor = encodeTipCursor(newest.ledgerAt, newest.txHash);

    const cachedPage = await getPublicRecentTips(SLUG, 7, cursor);
    expect(cachedPage.tips[0]?.txHash).toBe("hash_002");
    expect(cachedPage.tips[0]?.message).toBe("Spam message here!");

    await setTipMessageHidden(CREATOR_ID, "tip_002", true);

    const freshPage = await getPublicRecentTips(SLUG, 7, cursor);
    expect(freshPage.tips[0]?.txHash).toBe("hash_002");
    expect(freshPage.tips[0]?.message).toBe("");
  });
});
