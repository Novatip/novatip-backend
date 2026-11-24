/**
 * Writing a creator's splits must invalidate the collaborator-earnings cache,
 * so GET /analytics/collaborators reflects new splits immediately rather than
 * after the cache TTL.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR_ID = "creator_splits_cache";
const OWNER = "GOWNER0000000000000000000000000000000000000000000000000";
const ALICE = "GALICE0000000000000000000000000000000000000000000000000";
const BOB = "GBOB000000000000000000000000000000000000000000000000000";

let creatorRow: {
  id: string;
  slug: string;
  jarId: string;
  walletAddress: string;
  splits: unknown;
  updatedAt: Date;
};

const cache = new Map<string, unknown>();

const findUnique = jest.fn(async () => creatorRow);
const update = jest.fn(
  async (args: { data: { splits?: unknown; slug?: string } }) => {
    creatorRow = {
      ...creatorRow,
      ...(args.data.splits !== undefined && { splits: args.data.splits }),
      ...(args.data.slug !== undefined && { slug: args.data.slug }),
      updatedAt: new Date(),
    };
    return creatorRow;
  },
);
const queryRaw = jest.fn(async (query: { values: unknown[] }) => {
  const row: Record<string, unknown> = { tipCount: 0n, totalAmountRaw: "0" };
  query.values
    .filter((v) => typeof v === "number")
    .forEach((_, i) => {
      row[`s${i}`] = "0";
    });
  return [row];
});

const tx = {
  creator: { update },
  tip: { updateMany: async (): Promise<{ count: number }> => ({ count: 0 }) },
  releasedSlug: { upsert: async (): Promise<void> => undefined },
};

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique,
      findFirst: async (): Promise<null> => null,
      update,
    },
    releasedSlug: { findUnique: async (): Promise<null> => null },
    $queryRaw: queryRaw,
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: async (key: string) => cache.get(key) ?? null,
  cacheSet: async (key: string, value: unknown): Promise<void> => {
    cache.set(key, value);
  },
  cacheInvalidate: async (key: string): Promise<void> => {
    cache.delete(key);
  },
  cacheInvalidatePrefix: async (): Promise<void> => undefined,
  revokeCreatorTokens: async (): Promise<void> => undefined,
}));

const { updateCreatorSplits, claimSlug } =
  await import("../../modules/creator/creator.service.js");
const { getCollaboratorEarnings } =
  await import("../../modules/analytics/analytics.service.js");

beforeEach(() => {
  cache.clear();
  creatorRow = {
    id: CREATOR_ID,
    slug: "alice",
    jarId: "jar",
    walletAddress: OWNER,
    splits: [{ to: ALICE, bps: 10_000 }],
    updatedAt: new Date("2026-05-06T07:08:09.010Z"),
  };
});

describe("collaborator-earnings cache invalidation", () => {
  it("reflects new splits immediately after updateCreatorSplits", async () => {
    const before = await getCollaboratorEarnings(CREATOR_ID);
    expect(before.collaborators.map((c) => c.to)).toEqual([ALICE]);
    expect(cache.has(`analytics:collaborators:${CREATOR_ID}`)).toBe(true);

    await updateCreatorSplits(CREATOR_ID, [
      { to: ALICE, bps: 6_000 },
      { to: BOB, bps: 4_000 },
    ]);

    const after = await getCollaboratorEarnings(CREATOR_ID);
    expect(after.collaborators.map((c) => [c.to, c.bps])).toEqual([
      [ALICE, 6_000],
      [BOB, 4_000],
    ]);
  });

  it("drops the cached breakdown when a slug claim resets splits to empty", async () => {
    await getCollaboratorEarnings(CREATOR_ID);
    expect(cache.has(`analytics:collaborators:${CREATOR_ID}`)).toBe(true);

    creatorRow = { ...creatorRow, slug: "user_abcdef12" };
    await claimSlug({ creatorId: CREATOR_ID, slug: "newslug" });

    expect(cache.has(`analytics:collaborators:${CREATOR_ID}`)).toBe(false);
    const after = await getCollaboratorEarnings(CREATOR_ID);
    expect(after.basis.impliedOwnerSplit).toBe(true);
  });
});
