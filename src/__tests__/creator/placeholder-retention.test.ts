/**
 * __tests__/creator/placeholder-retention.test.ts
 *
 * Tests for prunePlaceholderCreators:
 * - Removes an abandoned placeholder past the retention window
 * - Protected: a claimed (non-placeholder) slug
 * - Protected: at least one tip
 * - Protected: at least one webhook
 * - Protected: at least one notification
 * - Protected: at least one released slug
 * - Protected: created too recently to be past the retention window
 * - Disabled entirely when the retention window is 0
 * - Batches: a backlog larger than one batch is deleted across batches,
 *   cursoring past a near-miss slug instead of stalling on it
 *
 * db is mocked with a small in-memory store that understands the exact
 * where-shape prunePlaceholderCreators sends (slug prefix, createdAt, and
 * the four relation-emptiness checks) — not a generic Prisma — so these
 * tests exercise the real filtering logic without a database.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

interface FakeCreatorRow {
  id: string;
  slug: string;
  createdAt: Date;
}

let creators: FakeCreatorRow[] = [];
let withTips = new Set<string>();
let withWebhooks = new Set<string>();
let withNotifications = new Set<string>();
let withReleasedSlugs = new Set<string>();

function resetStore(): void {
  creators = [];
  withTips = new Set();
  withWebhooks = new Set();
  withNotifications = new Set();
  withReleasedSlugs = new Set();
}

function isInert(id: string): boolean {
  return (
    !withTips.has(id) &&
    !withWebhooks.has(id) &&
    !withNotifications.has(id) &&
    !withReleasedSlugs.has(id)
  );
}

interface FindManyArgs {
  where: { slug: { startsWith: string }; createdAt: { lt: Date } };
  take: number;
  cursor?: { id: string };
  skip?: number;
}

const findManyMock = jest.fn(async (args: FindManyArgs) => {
  let candidates = creators
    .filter(
      (c) =>
        c.slug.startsWith(args.where.slug.startsWith) &&
        c.createdAt < args.where.createdAt.lt &&
        isInert(c.id),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Real Prisma/Postgres cursor pagination is a value comparison ("id >
  // cursor"), not a lookup of the cursor row itself — the previous batch's
  // last id is a valid cursor even after that row has been deleted, which
  // is exactly what happens between batches here.
  if (args.cursor) {
    candidates = candidates.filter((c) => c.id > args.cursor!.id);
  }

  return candidates
    .slice(0, args.take)
    .map((c) => ({ id: c.id, slug: c.slug }));
});

interface DeleteManyArgs {
  where: { id: { in: string[] } };
}

const deleteManyMock = jest.fn(async (args: DeleteManyArgs) => {
  const toDelete = args.where.id.in.filter((id) => isInert(id));
  creators = creators.filter((c) => !toDelete.includes(c.id));
  return { count: toDelete.length };
});

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: { findMany: findManyMock, deleteMany: deleteManyMock },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

const { config } = await import("../../config.js");
const { prunePlaceholderCreators, retentionEnabled, cutoffFor } =
  await import("../../modules/creator/placeholder-retention.js");

const NOW = new Date("2026-06-01T00:00:00.000Z");
const RETENTION_DAYS = config.creators.placeholderRetentionDays;

/**
 * config is `as const` (readonly at the type level, not frozen at runtime),
 * so overriding one setting for a single test needs a mutable-typed alias
 * rather than reloading the module graph — placeholder-retention.ts closes
 * over this same config object, and re-importing config.js alone (the way
 * config.test.ts does to get a fresh env-driven instance) wouldn't hand
 * that new instance to the already-imported retention module.
 */
async function withCreatorsConfigOverride<
  K extends keyof typeof config.creators,
>(
  key: K,
  value: (typeof config.creators)[K],
  run: () => Promise<void>,
): Promise<void> {
  const creatorsConfig = config.creators as unknown as Record<
    K,
    (typeof config.creators)[K]
  >;
  const original = creatorsConfig[key];
  creatorsConfig[key] = value;
  try {
    await run();
  } finally {
    creatorsConfig[key] = original;
  }
}

function placeholderSlug(suffix: string): string {
  // Exactly 8 lowercase hex characters, matching PLACEHOLDER_SLUG_REGEX.
  return `user_${suffix.padStart(8, "0")}`;
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

beforeEach(() => {
  resetStore();
  findManyMock.mockClear();
  deleteManyMock.mockClear();
});

describe("prunePlaceholderCreators", () => {
  it("removes an abandoned placeholder past the retention window", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    const result = await prunePlaceholderCreators(NOW);

    expect(result).toEqual({ deleted: 1, truncated: false });
    expect(creators).toHaveLength(0);
  });

  it("is a no-op when nothing is eligible", async () => {
    const result = await prunePlaceholderCreators(NOW);
    expect(result).toEqual({ deleted: 0, truncated: false });
    expect(findManyMock).toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("protects a creator who claimed a real slug", async () => {
    creators.push({
      id: "c1",
      slug: "alice",
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    await prunePlaceholderCreators(NOW);
    expect(creators).toHaveLength(1);
  });

  it("protects a placeholder with at least one tip", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });
    withTips.add("c1");

    await prunePlaceholderCreators(NOW);
    expect(creators).toHaveLength(1);
  });

  it("protects a placeholder with at least one webhook", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });
    withWebhooks.add("c1");

    await prunePlaceholderCreators(NOW);
    expect(creators).toHaveLength(1);
  });

  it("protects a placeholder with at least one notification", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });
    withNotifications.add("c1");

    await prunePlaceholderCreators(NOW);
    expect(creators).toHaveLength(1);
  });

  it("protects a placeholder with at least one released slug", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });
    withReleasedSlugs.add("c1");

    await prunePlaceholderCreators(NOW);
    expect(creators).toHaveLength(1);
  });

  it("protects a placeholder created too recently", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS - 1),
    });

    await prunePlaceholderCreators(NOW);
    expect(creators).toHaveLength(1);
  });

  it("does nothing when the retention window is 0", async () => {
    await withCreatorsConfigOverride(
      "placeholderRetentionDays",
      0,
      async () => {
        creators.push({
          id: "c1",
          slug: placeholderSlug("1"),
          createdAt: daysAgo(3_650),
        });

        expect(retentionEnabled()).toBe(false);

        const result = await prunePlaceholderCreators(NOW);

        expect(result).toEqual({ deleted: 0, truncated: false });
        expect(creators).toHaveLength(1);
        expect(findManyMock).not.toHaveBeenCalled();
      },
    );
  });

  it("deletes across batches and skips past a near-miss slug instead of stalling", async () => {
    await withCreatorsConfigOverride(
      "placeholderPruneBatchSize",
      2,
      async () => {
        // A slug starting with "user_" but not matching the exact
        // 8-hex-char placeholder pattern — claimable by a real creator, so
        // it must never be deleted, and the cursor must still advance past
        // it.
        creators.push({
          id: "near-miss",
          slug: "user_not-a-placeholder",
          createdAt: daysAgo(RETENTION_DAYS + 1),
        });
        for (let i = 0; i < 5; i++) {
          creators.push({
            id: `eligible-${i}`,
            slug: placeholderSlug(String(i)),
            createdAt: daysAgo(RETENTION_DAYS + 1),
          });
        }

        const result = await prunePlaceholderCreators(NOW);

        expect(result).toEqual({ deleted: 5, truncated: false });
        expect(creators).toEqual([
          expect.objectContaining({ id: "near-miss" }),
        ]);
        // 1 batch for the near-miss alone would never finish it off; more
        // than one findMany call means the cursor advanced rather than
        // re-selecting the same unselectable row forever.
        expect(findManyMock.mock.calls.length).toBeGreaterThan(1);
      },
    );
  });
});

describe("cutoffFor", () => {
  it("subtracts the given number of days", () => {
    expect(cutoffFor(30, NOW).getTime()).toBe(
      NOW.getTime() - 30 * 24 * 60 * 60 * 1000,
    );
  });
});

describe("Scheduler functions", () => {
  const {
    startPlaceholderCreatorPruner,
    stopPlaceholderCreatorPruner,
  } = await import("../../modules/creator/placeholder-retention.js");

  // Mock logger to avoid console noise in tests
  jest.unstable_mockModule("../../utils/logger.js", () => ({
    logger: {
      child: () => ({
        info: jest.fn(),
        error: jest.fn(),
      }),
    },
  }));

  afterEach(() => {
    stopPlaceholderCreatorPruner();
    jest.clearAllTimers();
  });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("should not start when retention is disabled", async () => {
    await withCreatorsConfigOverride(
      "placeholderRetentionDays",
      0,
      async () => {
        const findManyCallsBefore = findManyMock.mock.calls.length;
        
        startPlaceholderCreatorPruner();
        
        // Fast-forward past the first run delay
        await jest.advanceTimersByTimeAsync(60_000);
        
        // No prune should have been scheduled
        expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore);
      },
    );
  });

  it("should not schedule two timers when called twice", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    const findManyCallsBefore = findManyMock.mock.calls.length;

    startPlaceholderCreatorPruner();
    startPlaceholderCreatorPruner();

    // Fast-forward past the first run delay
    await jest.advanceTimersByTimeAsync(60_000);

    // Only one prune should have run
    expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore + 1);
  });

  it("should prevent a pending run from firing when stopped", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    const findManyCallsBefore = findManyMock.mock.calls.length;

    startPlaceholderCreatorPruner();
    
    // Stop before the first run delay elapses
    await jest.advanceTimersByTimeAsync(30_000);
    stopPlaceholderCreatorPruner();
    
    // Fast-forward past when the first run would have happened
    await jest.advanceTimersByTimeAsync(60_000);

    // No prune should have run
    expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore);
  });

  it("should reschedule itself after a successful pass", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    const findManyCallsBefore = findManyMock.mock.calls.length;

    startPlaceholderCreatorPruner();

    // First run after initial delay
    await jest.advanceTimersByTimeAsync(60_000);
    expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore + 1);

    creators.push({
      id: "c2",
      slug: placeholderSlug("2"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    // Second run after the configured interval
    const intervalMs = config.creators.placeholderPruneIntervalMinutes * 60_000;
    await jest.advanceTimersByTimeAsync(intervalMs);
    expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore + 2);
  });

  it("should not reschedule if stopped during a run", async () => {
    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    const findManyCallsBefore = findManyMock.mock.calls.length;

    startPlaceholderCreatorPruner();

    // First run
    await jest.advanceTimersByTimeAsync(60_000);
    expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore + 1);

    // Stop after the run completes but before next one is scheduled
    stopPlaceholderCreatorPruner();

    creators.push({
      id: "c2",
      slug: placeholderSlug("2"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    // Try to advance to the next run - it shouldn't happen
    const intervalMs = config.creators.placeholderPruneIntervalMinutes * 60_000;
    await jest.advanceTimersByTimeAsync(intervalMs);
    expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore + 1);
  });

  it("should log and reschedule when prunePlaceholderCreators rejects", async () => {
    // Make findMany throw an error
    findManyMock.mockRejectedValueOnce(new Error("Database error"));

    const findManyCallsBefore = findManyMock.mock.calls.length;

    startPlaceholderCreatorPruner();

    // First run (will fail)
    await jest.advanceTimersByTimeAsync(60_000);
    expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore + 1);

    // Restore normal behavior for the next run
    findManyMock.mockResolvedValueOnce([]);

    creators.push({
      id: "c1",
      slug: placeholderSlug("1"),
      createdAt: daysAgo(RETENTION_DAYS + 1),
    });

    // Second run should still happen despite the first one failing
    const intervalMs = config.creators.placeholderPruneIntervalMinutes * 60_000;
    await jest.advanceTimersByTimeAsync(intervalMs);
    expect(findManyMock.mock.calls.length).toBe(findManyCallsBefore + 2);
  });
});
