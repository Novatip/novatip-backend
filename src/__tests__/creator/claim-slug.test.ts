/**
 * __tests__/creator/claim-slug.test.ts
 *
 * Covers claimSlug's distinct failure paths: the slug format check, the
 * reserved-slug list, the availability pre-check (SLUG_TAKEN), the one-claim
 * guard (ALREADY_CLAIMED — a creator already on a real slug is refused, and
 * the refused claim leaves slug, jarId and splits untouched), and
 * toClaimConflict, which turns a losing race's Prisma P2002 into the same
 * 409 shape rather than letting it fall through to the global handler's
 * 500. That mapping was added to fix a real bug — a lost race surfacing as a
 * 500 — so it is the one most worth pinning here.
 *
 * db and redis are mocked so this runs without PostgreSQL or Redis. Only the
 * calls claimSlug actually makes are modelled — creator.findUnique for the
 * current-creator lookup and the availability pre-check, creator.update for
 * the write, and releasedSlug for the hold pre-check (never active here).
 * getCreatorBySlug and isSlugAvailable are out of scope for this file.
 *
 * config.ts validates required env vars at module load, so those are set
 * before the module graph is imported.
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

const findUniqueMock =
  jest.fn<
    (args: {
      where: { id?: string | undefined; slug?: string | undefined };
    }) => Promise<FakeCreatorRow | null>
  >();
const updateMock =
  jest.fn<
    (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<FakeCreatorRow>
  >();
const cacheInvalidateMock = jest.fn<(key: string) => Promise<void>>();
// Holds are never active in this file — claimSlug's hold pre-check still
// queries the table, so the model exists here returning no row.
const releasedFindUniqueMock =
  jest.fn<(args: { where: { slug: string } }) => Promise<null>>();
const releasedUpsertMock = jest.fn<(args: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: { findUnique: findUniqueMock, update: updateMock },
    releasedSlug: {
      findUnique: releasedFindUniqueMock,
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

const { claimSlug, updateProfile, updateCreatorSplits } = await import(
  "../../modules/creator/creator.service.js"
);

const CREATOR = "creator_alice";
const OTHER_CREATOR = "creator_bob";

function row(overrides: Partial<FakeCreatorRow> = {}): FakeCreatorRow {
  return {
    id: CREATOR,
    slug: "alice",
    jarId: "@alice",
    displayName: null,
    bio: null,
    splits: [],
    ...overrides,
  };
}

/** A Prisma P2002 as it actually arrives: a unique constraint violation. */
function uniqueConstraintError(
  target: string[],
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target.join(", ")})`,
    { code: "P2002", clientVersion: "5.15.0", meta: { target } },
  );
}

function recordNotFoundError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Record to update not found.",
    { code: "P2025", clientVersion: "5.15.0" },
  );
}

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  cacheInvalidateMock.mockReset();
  releasedFindUniqueMock.mockReset().mockResolvedValue(null);
  releasedUpsertMock.mockReset();
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("an invalid slug", () => {
  test.each([
    ["too short", "ab"],
    ["uppercase", "Alice"],
    ["a disallowed character", "al.ice"],
    ["a space", "al ice"],
  ])("rejects %s with a 400, not a 500", async (_label, slug) => {
    await expect(claimSlug({ creatorId: CREATOR, slug })).rejects.toMatchObject(
      { statusCode: 400 },
    );

    // Rejected before any query is even attempted.
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("a reserved slug", () => {
  test.each(["api", "admin", "dashboard", "novatip"])(
    "rejects %s with a 400, not a 500",
    async (slug) => {
      await expect(
        claimSlug({ creatorId: CREATOR, slug }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findUniqueMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    },
  );
});

// ── Availability pre-check ──────────────────────────────────────────────────────

describe("a slug already taken by another creator", () => {
  test("rejects with 409 SLUG_TAKEN and never attempts the write", async () => {
    findUniqueMock.mockResolvedValue(row({ id: OTHER_CREATOR }));

    await expect(
      claimSlug({ creatorId: CREATOR, slug: "alice" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLUG_TAKEN" });

    expect(updateMock).not.toHaveBeenCalled();
    expect(cacheInvalidateMock).not.toHaveBeenCalled();
  });
});

describe("re-claiming your own slug", () => {
  test("is refused with ALREADY_CLAIMED — the claim is one-time", async () => {
    // Same creator, same slug, nobody else's row in the way — and still
    // refused. The pre-check's "own row is not a conflict" nuance only ever
    // mattered for second claims, and the one-claim rule bars those outright:
    // there is nothing left to conflict with, only a placeholder that has
    // already become real.
    findUniqueMock.mockResolvedValue(row({ id: CREATOR, slug: "alice" }));

    await expect(
      claimSlug({ creatorId: CREATOR, slug: "alice" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_CLAIMED" });

    expect(updateMock).not.toHaveBeenCalled();
    expect(cacheInvalidateMock).not.toHaveBeenCalled();
  });
});

// ── The one-claim rule ─────────────────────────────────────────────────────────

describe("a creator who already holds a real slug", () => {
  test("a second claim is refused with 409 ALREADY_CLAIMED and writes nothing", async () => {
    // Stateful store: the assertion this whole fix exists for is that a
    // refused claim leaves slug, jarId and splits exactly as they were —
    // a write here would orphan the on-chain jar and reset the splits.
    const stored: FakeCreatorRow = row({
      slug: "alice",
      jarId: "@alice",
      splits: [{ to: `G${"B".repeat(55)}`, bps: 2_500 }],
    });
    findUniqueMock.mockImplementation(async (args) => {
      if (args.where.id !== undefined) return stored;
      return args.where.slug === stored.slug ? stored : null;
    });

    const err: unknown = await claimSlug({
      creatorId: CREATOR,
      slug: "brandnew",
      splits: [],
    }).catch((e: unknown) => e);

    // A distinct code: not SLUG_TAKEN, because the target slug is free —
    // what conflicted is that this caller has already claimed.
    expect(err).toMatchObject({ statusCode: 409, code: "ALREADY_CLAIMED" });
    expect(err).not.toMatchObject({ code: "SLUG_TAKEN" });

    expect(updateMock).not.toHaveBeenCalled();
    expect(releasedUpsertMock).not.toHaveBeenCalled();
    expect(cacheInvalidateMock).not.toHaveBeenCalled();
    expect(stored).toEqual(
      row({
        slug: "alice",
        jarId: "@alice",
        splits: [{ to: `G${"B".repeat(55)}`, bps: 2_500 }],
      }),
    );
  });

  test("a creator on the sign-in placeholder can still claim", async () => {
    findUniqueMock.mockImplementation(async (args) => {
      if (args.where.id !== undefined) {
        return row({
          id: CREATOR,
          slug: "user_1234abcd",
          jarId: "@user_1234abcd",
        });
      }
      return null; // the target slug is free
    });
    updateMock.mockResolvedValue(row({ slug: "newslug", jarId: "@newslug" }));

    await expect(
      claimSlug({ creatorId: CREATOR, slug: "newslug" }),
    ).resolves.toMatchObject({ slug: "newslug", jarId: "@newslug" });

    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["seven hex chars", "user_1234abc"],
    ["nine hex chars", "user_1234abcde"],
    ["a non-hex suffix", "user_1234abz"],
  ])(
    "a current slug that is not the placeholder (%s) is refused",
    async (_label, currentSlug) => {
      findUniqueMock.mockImplementation(async (args) => {
        if (args.where.id !== undefined) {
          return row({
            id: CREATOR,
            slug: currentSlug,
            jarId: `@${currentSlug}`,
          });
        }
        return null;
      });

      await expect(
        claimSlug({ creatorId: CREATOR, slug: "brandnew" }),
      ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_CLAIMED" });

      expect(updateMock).not.toHaveBeenCalled();
    },
  );
});

describe("claiming a free slug", () => {
  test("writes the claim and invalidates the slug's cache entry", async () => {
    findUniqueMock.mockResolvedValue(null);
    updateMock.mockResolvedValue(row({ slug: "newslug", jarId: "@newslug" }));

    await expect(
      claimSlug({ creatorId: CREATOR, slug: "newslug" }),
    ).resolves.toMatchObject({ slug: "newslug" });

    expect(cacheInvalidateMock).toHaveBeenCalledWith("creator:newslug");
  });
});

describe("updates for a deleted creator", () => {
  async function expectNotFound(update: () => Promise<unknown>) {
    findUniqueMock.mockResolvedValue(null);
    updateMock.mockRejectedValue(recordNotFoundError());

    await expect(update()).rejects.toMatchObject({
      statusCode: 404,
      message: "Creator not found.",
    });
  }

  it("claimSlug returns a sanitized 404 when the update finds no record", async () => {
    await expectNotFound(() =>
      claimSlug({ creatorId: CREATOR, slug: "newslug" }),
    );
  });

  it("updateProfile returns a sanitized 404 when the update finds no record", async () => {
    await expectNotFound(() =>
      updateProfile({ creatorId: CREATOR, displayName: "Alice" }),
    );
  });

  it("updateCreatorSplits returns a sanitized 404 when the update finds no record", async () => {
    await expectNotFound(() => updateCreatorSplits(CREATOR, []));
  });
});

// ── The P2002 race ───────────────────────────────────────────────────────────────

describe("a losing race against another claim", () => {
  test("a P2002 on slug becomes 409 SLUG_TAKEN", async () => {
    // Passes the pre-check (nobody held the slug a moment ago)...
    findUniqueMock.mockResolvedValue(null);
    // ...but loses the write to a concurrent claimant who got there first.
    updateMock.mockRejectedValue(uniqueConstraintError(["slug"]));

    await expect(
      claimSlug({ creatorId: CREATOR, slug: "alice" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLUG_TAKEN" });

    // The failed write must not evict a cache entry that was never this
    // claimant's to invalidate.
    expect(cacheInvalidateMock).not.toHaveBeenCalled();
  });

  test("a P2002 on jarId becomes 409 JARID_TAKEN", async () => {
    findUniqueMock.mockResolvedValue(null);
    updateMock.mockRejectedValue(uniqueConstraintError(["jarId"]));

    await expect(
      claimSlug({ creatorId: CREATOR, slug: "alice" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "JARID_TAKEN" });

    expect(cacheInvalidateMock).not.toHaveBeenCalled();
  });

  test("any other P2002 still comes back as a 409, not a 500", async () => {
    // toClaimConflict's test is only "did jarId conflict" — anything else
    // (an unexpected unique violation on some other column) falls back to
    // the same SLUG_TAKEN shape rather than being rethrown bare, which is
    // what would reach the global handler with no statusCode and surface
    // as a 500.
    findUniqueMock.mockResolvedValue(null);
    updateMock.mockRejectedValue(uniqueConstraintError(["id"]));

    await expect(
      claimSlug({ creatorId: CREATOR, slug: "alice" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("an error that is not a P2002 passes through untouched", async () => {
    findUniqueMock.mockResolvedValue(null);
    const dbDown = new Error("connection terminated unexpectedly");
    updateMock.mockRejectedValue(dbDown);

    // No statusCode was ever attached — this is exactly what should reach
    // the global handler and surface as a 500, unlike a real conflict.
    await expect(claimSlug({ creatorId: CREATOR, slug: "alice" })).rejects.toBe(
      dbDown,
    );
  });
});
