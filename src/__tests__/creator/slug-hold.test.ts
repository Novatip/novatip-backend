/**
 * __tests__/creator/slug-hold.test.ts
 *
 * The hold window on a released slug. Once a creator renames (or a
 * first-time claimant claims), their old slug used to be free instantly —
 * stale links, printed posters and QR codes kept pointing at it, and
 * whoever claimed next collected that traffic and showed their own wallet
 * to people who meant to tip the original creator. A released slug is now
 * recorded with a timestamp and stays held for CREATOR_SLUG_HOLD_DAYS
 * (default 90) for its previous owner alone.
 *
 * Covers, per the acceptance criteria:
 * - A held slug: unavailable to anonymous callers and other creators, from
 *   the availability check and from claim/rename alike (409 SLUG_TAKEN)
 * - An expired hold: the slug is free for anyone again — a stranger still on
 *   the sign-in placeholder claims it (releasing their placeholder in the
 *   process), a stranger holding a real slug is refused the claim by the
 *   one-claim rule and renames instead
 * - The previous owner during the hold: available to them, renameable back
 *   to them while the hold is still running; their claim is refused too
 *   (409 ALREADY_CLAIMED) because claiming is the one-time placeholder→real
 *   transition, not how an existing slug switches
 * Plus the recording side (rename writes the release with a timestamp, a
 * later release restarts the window), the configured default, and the
 * public availability endpoint honouring the owner exemption via JWT.
 *
 * db and redis are mocked; no PostgreSQL or Redis is required. config.ts
 * validates required env vars at module load, so those are set before the
 * module graph is imported.
 */

import { jest } from "@jest/globals";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import jwtPlugin from "@fastify/jwt";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
// Deliberately left unset: the tests below assert the documented default.

const DAY_MS = 86_400_000;
const ALICE = "creator_alice";
const BOB = "creator_bob";

interface FakeCreatorRow {
  id: string;
  slug: string;
  jarId: string;
  displayName: string | null;
  bio: string | null;
  splits: unknown;
}

interface FakeReleaseRow {
  slug: string;
  previousOwnerId: string | null;
  releasedAt: Date;
}

let creators = new Map<string, FakeCreatorRow>();
let releases = new Map<string, FakeReleaseRow>();

const creatorFindUniqueMock = jest.fn(
  async (args: { where: { id?: string; slug?: string } }) => {
    if (args.where.id !== undefined) return creators.get(args.where.id) ?? null;
    if (args.where.slug !== undefined) {
      for (const creator of creators.values()) {
        if (creator.slug === args.where.slug) return creator;
      }
    }
    return null;
  },
);

const creatorUpdateMock = jest.fn(
  async (args: { where: { id: string }; data: Partial<FakeCreatorRow> }) => {
    const existing = creators.get(args.where.id);
    if (!existing) throw new Error("Record to update not found.");
    const updated = { ...existing, ...args.data };
    creators.set(args.where.id, updated);
    return updated;
  },
);

const releasedFindUniqueMock = jest.fn(
  async (args: { where: { slug: string } }) =>
    releases.get(args.where.slug) ?? null,
);

const releasedUpsertMock = jest.fn(
  async (args: {
    where: { slug: string };
    create: FakeReleaseRow;
    update: { previousOwnerId: string | null; releasedAt: Date };
  }) => {
    const existing = releases.get(args.where.slug);
    const row = existing ? { ...existing, ...args.update } : { ...args.create };
    releases.set(args.where.slug, row);
    return row;
  },
);

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: creatorFindUniqueMock,
      update: creatorUpdateMock,
    },
    releasedSlug: {
      findUnique: releasedFindUniqueMock,
      upsert: releasedUpsertMock,
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheInvalidate: jest.fn(async () => undefined),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  revokeCreatorTokens: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { claimSlug, renameSlug, isSlugAvailable } =
  await import("../../modules/creator/creator.service.js");
const { creatorRoutes } =
  await import("../../modules/creator/creator.routes.js");
const { config } = await import("../../config.js");

function holdSlug(
  slug: string,
  previousOwnerId: string,
  releasedAt: Date,
): void {
  releases.set(slug, { slug, previousOwnerId, releasedAt });
}

beforeEach(() => {
  jest.clearAllMocks();
  creators = new Map();
  releases = new Map();
  creators.set(ALICE, {
    id: ALICE,
    slug: "alice",
    jarId: "@alice",
    displayName: null,
    bio: null,
    splits: [],
  });
  creators.set(BOB, {
    id: BOB,
    slug: "bob",
    jarId: "@bob",
    displayName: null,
    bio: null,
    splits: [],
  });
});

// ── Configuration ─────────────────────────────────────────────────────────────

describe("the hold period", () => {
  test("defaults to 90 days", () => {
    expect(config.creators.slugHoldDays).toBe(90);
  });

  test("is configurable via CREATOR_SLUG_HOLD_DAYS", async () => {
    const previous = process.env["CREATOR_SLUG_HOLD_DAYS"];
    process.env["CREATOR_SLUG_HOLD_DAYS"] = "7";
    try {
      await jest.isolateModulesAsync(async () => {
        const fresh = await import("../../config.js");
        expect(fresh.config.creators.slugHoldDays).toBe(7);
      });
    } finally {
      if (previous === undefined) {
        delete process.env["CREATOR_SLUG_HOLD_DAYS"];
      } else {
        process.env["CREATOR_SLUG_HOLD_DAYS"] = previous;
      }
    }
  });
});

// ── A held slug ───────────────────────────────────────────────────────────────

describe("a slug released recently (held)", () => {
  beforeEach(() => {
    holdSlug("oldslug", ALICE, new Date(Date.now() - 1 * DAY_MS));
  });

  test("reports unavailable to anonymous callers", async () => {
    await expect(isSlugAvailable("oldslug")).resolves.toBe(false);
  });

  test("reports unavailable to another creator", async () => {
    await expect(isSlugAvailable("oldslug", BOB)).resolves.toBe(false);
  });

  test("another creator cannot claim it", async () => {
    await expect(
      claimSlug({ creatorId: BOB, slug: "oldslug" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLUG_TAKEN" });

    expect(creators.get(BOB)?.slug).toBe("bob");
    expect(creatorUpdateMock).not.toHaveBeenCalled();
    expect(releasedUpsertMock).not.toHaveBeenCalled();
  });

  test("another creator cannot rename to it", async () => {
    await expect(
      renameSlug({ creatorId: BOB, slug: "oldslug" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLUG_TAKEN" });

    expect(creators.get(BOB)?.slug).toBe("bob");
    expect(creatorUpdateMock).not.toHaveBeenCalled();
    expect(releasedUpsertMock).not.toHaveBeenCalled();
  });

  test("a hold one day short of the window still bars others", async () => {
    holdSlug("almostfree", ALICE, new Date(Date.now() - 89 * DAY_MS));
    await expect(isSlugAvailable("almostfree", BOB)).resolves.toBe(false);
  });

  test("a hold exactly at the window has lapsed", async () => {
    holdSlug("boundary", ALICE, new Date(Date.now() - 90 * DAY_MS));
    await expect(isSlugAvailable("boundary", BOB)).resolves.toBe(true);
  });
});

// ── An expired hold ───────────────────────────────────────────────────────────

describe("a hold that has expired", () => {
  beforeEach(() => {
    holdSlug("oldslug", ALICE, new Date(Date.now() - 91 * DAY_MS));
  });

  test("reports available to anyone again", async () => {
    await expect(isSlugAvailable("oldslug")).resolves.toBe(true);
    await expect(isSlugAvailable("oldslug", BOB)).resolves.toBe(true);
    await expect(isSlugAvailable("oldslug", ALICE)).resolves.toBe(true);
  });

  test("a creator on the sign-in placeholder can claim it", async () => {
    // A first-time claimant is the only kind claimSlug still lets through,
    // and their claim releases the placeholder they arrived with.
    const NEWCOMER = "creator_newcomer";
    creators.set(NEWCOMER, {
      id: NEWCOMER,
      slug: "user_1234abcd",
      jarId: "@user_1234abcd",
      displayName: null,
      bio: null,
      splits: [],
    });

    await expect(
      claimSlug({ creatorId: NEWCOMER, slug: "oldslug" }),
    ).resolves.toMatchObject({ slug: "oldslug", jarId: "@oldslug" });

    expect(creators.get(NEWCOMER)?.slug).toBe("oldslug");

    // The placeholder left behind gets its own fresh release record, so the
    // hold machinery treats it exactly like a slug a creator walked away from.
    const newcomerOldSlug = releases.get("user_1234abcd");
    expect(newcomerOldSlug).toMatchObject({
      slug: "user_1234abcd",
      previousOwnerId: NEWCOMER,
    });
    expect(newcomerOldSlug?.releasedAt.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  test("a creator with a real slug is refused — renaming is the path", async () => {
    await expect(
      claimSlug({ creatorId: BOB, slug: "oldslug" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_CLAIMED" });

    expect(creators.get(BOB)?.slug).toBe("bob");
    expect(creatorUpdateMock).not.toHaveBeenCalled();
    expect(releases.get("bob")).toBeUndefined();
  });

  test("another creator can rename to it", async () => {
    await expect(
      renameSlug({ creatorId: BOB, slug: "oldslug" }),
    ).resolves.toMatchObject({ slug: "oldslug" });

    expect(creators.get(BOB)?.slug).toBe("oldslug");
    expect(releases.get("bob")).toMatchObject({
      slug: "bob",
      previousOwnerId: BOB,
    });
  });
});

// ── The previous owner reclaiming it ──────────────────────────────────────────

describe("the previous owner during the hold", () => {
  beforeEach(() => {
    holdSlug("oldslug", ALICE, new Date(Date.now() - 1 * DAY_MS));
  });

  test("sees it as available while everyone else is barred", async () => {
    await expect(isSlugAvailable("oldslug", ALICE)).resolves.toBe(true);
    await expect(isSlugAvailable("oldslug", BOB)).resolves.toBe(false);
    await expect(isSlugAvailable("oldslug")).resolves.toBe(false);
  });

  test("cannot claim it back — the hold exempts them, the one-claim rule does not", async () => {
    // The hold still exempts ALICE (asserted via isSlugAvailable and the
    // rename test below); what bars her here is that claiming is the
    // one-time placeholder→real transition, and she holds a real slug.
    await expect(
      claimSlug({ creatorId: ALICE, slug: "oldslug" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_CLAIMED" });

    expect(creators.get(ALICE)?.slug).toBe("alice");
    expect(creatorUpdateMock).not.toHaveBeenCalled();
    expect(releases.get("alice")).toBeUndefined();
  });

  test("can rename back to it", async () => {
    await expect(
      renameSlug({ creatorId: ALICE, slug: "oldslug" }),
    ).resolves.toMatchObject({ slug: "oldslug" });

    expect(creators.get(ALICE)?.slug).toBe("oldslug");
    expect(releases.get("alice")).toMatchObject({
      slug: "alice",
      previousOwnerId: ALICE,
    });
  });
});

// ── Recording the release ─────────────────────────────────────────────────────

describe("recording a released slug", () => {
  test("rename records the slug left behind with a timestamp", async () => {
    const before = Date.now();
    await renameSlug({ creatorId: ALICE, slug: "alicia" });

    const released = releases.get("alice");
    expect(released).toMatchObject({ slug: "alice", previousOwnerId: ALICE });
    expect(released?.releasedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(released?.releasedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("re-releasing a slug restarts its window instead of colliding", async () => {
    // ALICE holds "alice" again after an earlier release — its row is still
    // there, nearly expired.
    holdSlug("alice", ALICE, new Date(Date.now() - 89 * DAY_MS));

    await renameSlug({ creatorId: ALICE, slug: "alicia" });

    const released = releases.get("alice");
    expect(released?.previousOwnerId).toBe(ALICE);
    expect(released?.releasedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Fresh window: held for BOB, exempt for ALICE.
    await expect(isSlugAvailable("alice", BOB)).resolves.toBe(false);
    await expect(isSlugAvailable("alice", ALICE)).resolves.toBe(true);
  });

  test("a no-op rename records no release", async () => {
    await renameSlug({ creatorId: ALICE, slug: "alice" });
    expect(releasedUpsertMock).not.toHaveBeenCalled();
  });
});

describe("a slug held after account deletion", () => {
  const NEWCOMER = "creator_newcomer";

  beforeEach(() => {
    creators.set(NEWCOMER, {
      id: NEWCOMER,
      slug: "user_1234abcd",
      jarId: "@user_1234abcd",
      displayName: null,
      bio: null,
      splits: [],
    });
    holdSlug("deletedslug", null, new Date(Date.now() - DAY_MS));
  });

  test("is unavailable and cannot be claimed during the hold", async () => {
    await expect(isSlugAvailable("deletedslug")).resolves.toBe(false);
    await expect(isSlugAvailable("deletedslug", BOB)).resolves.toBe(false);
    await expect(
      claimSlug({ creatorId: NEWCOMER, slug: "deletedslug" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLUG_TAKEN" });
  });

  test("becomes available and claimable when the hold expires", async () => {
    holdSlug("deletedslug", null, new Date(Date.now() - 91 * DAY_MS));

    await expect(isSlugAvailable("deletedslug")).resolves.toBe(true);
    await expect(
      claimSlug({ creatorId: NEWCOMER, slug: "deletedslug" }),
    ).resolves.toMatchObject({ slug: "deletedslug", jarId: "@deletedslug" });
  });
});

// ── The public availability endpoint ──────────────────────────────────────────

describe("GET /check/:slug with a hold in place", () => {
  const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  let app: FastifyInstance;

  beforeEach(async () => {
    holdSlug("oldslug", ALICE, new Date(Date.now() - 1 * DAY_MS));

    app = Fastify();
    await app.register(jwtPlugin, {
      secret: "test-secret-at-least-32-chars-long-123456",
    });
    app.decorate(
      "authenticate",
      async function (request: FastifyRequest, reply: FastifyReply) {
        try {
          await request.jwtVerify();
        } catch {
          reply.status(401).send({
            error: {
              code: "UNAUTHORIZED",
              message: "Authentication required.",
            },
          });
        }
      },
    );
    await app.register(creatorRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test("reads unavailable for an anonymous caller", async () => {
    const res = await app.inject({ method: "GET", url: "/check/oldslug" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slug: "oldslug", available: false });
  });

  test("reads unavailable for another creator's token", async () => {
    const token = app.jwt.sign({ sub: BOB, wallet: WALLET, slug: "bob" });
    const res = await app.inject({
      method: "GET",
      url: "/check/oldslug",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json()).toEqual({ slug: "oldslug", available: false });
  });

  test("reads available for the previous owner's token", async () => {
    const token = app.jwt.sign({ sub: ALICE, wallet: WALLET, slug: "alice" });
    const res = await app.inject({
      method: "GET",
      url: "/check/oldslug",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json()).toEqual({ slug: "oldslug", available: true });
  });

  test("does not grant the hold exemption for an email-verification token", async () => {
    const token = app.jwt.sign({
      sub: ALICE,
      email: "alice@example.com",
      purpose: "creator-email-verification",
    });
    const res = await app.inject({
      method: "GET",
      url: "/check/oldslug",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slug: "oldslug", available: false });
  });
});
