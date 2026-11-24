/**
 * __tests__/creator/rename-slug.test.ts
 *
 * Tests for renameSlug:
 * - Validation: invalid slug pattern (400), reserved slugs (400)
 * - Availability pre-check: taken by another creator (409 SLUG_TAKEN)
 * - Concurrent conflict: race condition causing P2002 on slug (409 SLUG_TAKEN)
 * - Unchanged slug: re-submitting current slug succeeds without conflict
 * - Successful rename: preserves jarId and splits, updates slug in DB,
 *   and invalidates the resolver cache for both the old and new slug
 * - Missing creator: 404 if creator record does not exist
 */

import { jest } from "@jest/globals";
import { Prisma } from "@prisma/client";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

interface FakeCreatorRow {
  id: string;
  slug: string;
  jarId: string;
  displayName: string | null;
  bio: string | null;
  splits: unknown;
}

const findUniqueMock = jest.fn<
  (args: { where: { id?: string; slug?: string } }) => Promise<FakeCreatorRow | null>
>();
const updateMock = jest.fn<
  (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<FakeCreatorRow>
>();
const cacheInvalidateMock = jest.fn<(key: string) => Promise<void>>();
// renameSlug queries holds before every write and records a release after a
// successful one; both modelled here so no row is held in this file.
const releasedFindUniqueMock =
  jest.fn<(args: { where: { slug: string } }) => Promise<null>>();
const releasedFindFirstMock =
  jest.fn<(args: {
    where: { previousOwnerId: string };
    orderBy: { releasedAt: "desc" };
  }) => Promise<{ slug: string; previousOwnerId: string; releasedAt: Date } | null>>();
const releasedUpsertMock = jest.fn<(args: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: { findUnique: findUniqueMock, update: updateMock },
    releasedSlug: {
      findUnique: releasedFindUniqueMock,
      findFirst: releasedFindFirstMock,
      upsert: releasedUpsertMock,
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheInvalidate: cacheInvalidateMock,
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  revokeCreatorTokens: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { renameSlug } = await import("../../modules/creator/creator.service.js");

const CREATOR = "creator_alice";
const OTHER_CREATOR = "creator_bob";

function row(overrides: Partial<FakeCreatorRow> = {}): FakeCreatorRow {
  return {
    id: CREATOR,
    slug: "alice",
    jarId: "@alice",
    displayName: "Alice",
    bio: "Hello",
    splits: [{ to: "GA...", bps: 10000 }],
    ...overrides,
  };
}

function uniqueConstraintError(
  target: string[],
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target.join(", ")})`,
    { code: "P2002", clientVersion: "5.15.0", meta: { target } },
  );
}

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  cacheInvalidateMock.mockReset();
  releasedFindUniqueMock.mockReset().mockResolvedValue(null);
  releasedFindFirstMock.mockReset().mockResolvedValue(null);
  releasedUpsertMock.mockReset();
  
  // Reset config to default (cooldown disabled)
  process.env["CREATOR_SLUG_RENAME_COOLDOWN_DAYS"] = "0";
  jest.resetModules();
});

describe("renameSlug validation", () => {
  test.each([
    ["too short", "ab"],
    ["uppercase", "Alice"],
    ["disallowed character", "al.ice"],
    ["space", "al ice"],
  ])("rejects %s with a 400", async (_label, slug) => {
    await expect(
      renameSlug({ creatorId: CREATOR, slug }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  test.each(["api", "admin", "dashboard", "novatip"])(
    "rejects reserved slug %s with a 400",
    async (slug) => {
      await expect(
        renameSlug({ creatorId: CREATOR, slug }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findUniqueMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    },
  );
});

describe("renameSlug availability and creator lookup", () => {
  test("throws 404 when creator does not exist", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(
      renameSlug({ creatorId: CREATOR, slug: "alicia" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("rejects with 409 SLUG_TAKEN when slug is held by another creator", async () => {
    findUniqueMock
      .mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" })) // creator lookup
      .mockResolvedValueOnce(row({ id: OTHER_CREATOR, slug: "alicia" })); // slug lookup

    await expect(
      renameSlug({ creatorId: CREATOR, slug: "alicia" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLUG_TAKEN" });

    expect(updateMock).not.toHaveBeenCalled();
    expect(cacheInvalidateMock).not.toHaveBeenCalled();
  });

  test("unchanged slug does not conflict and returns the creator", async () => {
    findUniqueMock
      .mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }))
      .mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }));
    updateMock.mockResolvedValue(row({ id: CREATOR, slug: "alice" }));

    const result = await renameSlug({ creatorId: CREATOR, slug: "alice" });
    expect(result).toMatchObject({ slug: "alice", jarId: "@alice" });
    expect(cacheInvalidateMock).toHaveBeenCalledWith("creator:alice");
  });
});

describe("successful renameSlug", () => {
  test("renames slug, leaves jarId and splits untouched, and invalidates old and new caches", async () => {
    findUniqueMock
      .mockResolvedValueOnce(row({ id: CREATOR, slug: "alice", jarId: "@alice" }))
      .mockResolvedValueOnce(null); // new slug is free
    updateMock.mockResolvedValue(
      row({ id: CREATOR, slug: "alicia", jarId: "@alice" }),
    );

    const result = await renameSlug({ creatorId: CREATOR, slug: "alicia" });

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: CREATOR },
      data: { slug: "alicia" },
    });
    expect(result.slug).toBe("alicia");
    expect(result.jarId).toBe("@alice");

    // The slug left behind is recorded as released, timestamped, so a hold
    // can run against it (see slug-hold.test.ts).
    expect(releasedUpsertMock).toHaveBeenCalledWith({
      where: { slug: "alice" },
      create: {
        slug: "alice",
        previousOwnerId: CREATOR,
        releasedAt: expect.any(Date),
      },
      update: { previousOwnerId: CREATOR, releasedAt: expect.any(Date) },
    });

    expect(cacheInvalidateMock).toHaveBeenCalledWith("creator:alice");
    expect(cacheInvalidateMock).toHaveBeenCalledWith("creator:alicia");
  });

  test("maps race-condition P2002 to 409 SLUG_TAKEN", async () => {
    findUniqueMock
      .mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }))
      .mockResolvedValueOnce(null);
    updateMock.mockRejectedValue(uniqueConstraintError(["slug"]));

    await expect(
      renameSlug({ creatorId: CREATOR, slug: "alicia" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLUG_TAKEN" });

    expect(cacheInvalidateMock).not.toHaveBeenCalled();
  });
});

describe("rename cooldown", () => {
  beforeEach(() => {
    // Enable cooldown for these tests
    process.env["CREATOR_SLUG_RENAME_COOLDOWN_DAYS"] = "30";
  });

  test("allows first rename after claiming (no previous release)", async () => {
    findUniqueMock
      .mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }))
      .mockResolvedValueOnce(null);
    releasedFindFirstMock.mockResolvedValue(null); // No previous renames
    updateMock.mockResolvedValue(row({ id: CREATOR, slug: "alicia" }));

    const result = await renameSlug({ creatorId: CREATOR, slug: "alicia" });
    expect(result.slug).toBe("alicia");
  });

  test("allows rename after cooldown period has elapsed", async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    
    findUniqueMock
      .mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }))
      .mockResolvedValueOnce(null);
    releasedFindFirstMock.mockResolvedValue({
      slug: "oldslug",
      previousOwnerId: CREATOR,
      releasedAt: thirtyOneDaysAgo,
    });
    updateMock.mockResolvedValue(row({ id: CREATOR, slug: "alicia" }));

    const result = await renameSlug({ creatorId: CREATOR, slug: "alicia" });
    expect(result.slug).toBe("alicia");
  });

  test("rejects rename inside cooldown with 429 RENAME_COOLDOWN", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    
    findUniqueMock.mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }));
    releasedFindFirstMock.mockResolvedValue({
      slug: "oldslug",
      previousOwnerId: CREATOR,
      releasedAt: tenDaysAgo,
    });

    await expect(
      renameSlug({ creatorId: CREATOR, slug: "alicia" }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: "RENAME_COOLDOWN",
    });

    expect(updateMock).not.toHaveBeenCalled();
    expect(cacheInvalidateMock).not.toHaveBeenCalled();
  });

  test("429 response includes nextAllowedAt timestamp", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    
    findUniqueMock.mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }));
    releasedFindFirstMock.mockResolvedValue({
      slug: "oldslug",
      previousOwnerId: CREATOR,
      releasedAt: tenDaysAgo,
    });

    try {
      await renameSlug({ creatorId: CREATOR, slug: "alicia" });
      fail("Should have thrown");
    } catch (error: unknown) {
      expect(error).toMatchObject({
        statusCode: 429,
        code: "RENAME_COOLDOWN",
        nextAllowedAt: expect.any(String),
      });
      
      // Verify nextAllowedAt is a valid ISO date
      const nextDate = new Date((error as { nextAllowedAt: string }).nextAllowedAt);
      expect(nextDate.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test("cooldown disabled (0 days) allows unlimited renames", async () => {
    process.env["CREATOR_SLUG_RENAME_COOLDOWN_DAYS"] = "0";
    
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    findUniqueMock
      .mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }))
      .mockResolvedValueOnce(null);
    releasedFindFirstMock.mockResolvedValue({
      slug: "oldslug",
      previousOwnerId: CREATOR,
      releasedAt: oneDayAgo,
    });
    updateMock.mockResolvedValue(row({ id: CREATOR, slug: "alicia" }));

    const result = await renameSlug({ creatorId: CREATOR, slug: "alicia" });
    expect(result.slug).toBe("alicia");
  });

  test("error message states the date when next rename is allowed", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const expectedNextDate = new Date(tenDaysAgo.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    findUniqueMock.mockResolvedValueOnce(row({ id: CREATOR, slug: "alice" }));
    releasedFindFirstMock.mockResolvedValue({
      slug: "oldslug",
      previousOwnerId: CREATOR,
      releasedAt: tenDaysAgo,
    });

    try {
      await renameSlug({ creatorId: CREATOR, slug: "alicia" });
      fail("Should have thrown");
    } catch (error: unknown) {
      const message = (error as Error).message;
      expect(message).toContain(expectedNextDate.toISOString().slice(0, 10));
      expect(message).toMatch(/You may rename again on \d{4}-\d{2}-\d{2}/);
    }
  });
});
