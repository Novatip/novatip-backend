/**
 * __tests__/auth/auth-me-fresh-slug.test.ts
 *
 * Tests for GET /auth/me:
 * - Reads current slug from database by sub rather than relying on stale JWT claims (#124)
 * - Returns 401 when creator no longer exists in database
 * - Claims a slug and asserts /auth/me returns the newly claimed slug using the original token
 */

import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

interface CreatorRecord {
  id: string;
  walletAddress: string;
  slug: string;
  jarId: string;
  emailVerifiedAt: Date | null;
  displayName: string | null;
  bio: string | null;
  splits: unknown;
}

let creatorsDb = new Map<string, CreatorRecord>();

const findUniqueMock = jest.fn(
  async (args: {
    where: { id?: string; walletAddress?: string; slug?: string };
    select?: Record<string, boolean>;
  }) => {
    if (args.where.id) {
      const creator = creatorsDb.get(args.where.id);
      if (!creator) return null;
      if (args.select) {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(args.select)) {
          if (val) out[key] = creator[key as keyof CreatorRecord];
        }
        return out;
      }
      return creator;
    }
    if (args.where.slug) {
      for (const creator of creatorsDb.values()) {
        if (creator.slug === args.where.slug) return creator;
      }
      return null;
    }
    return null;
  },
);

const updateMock = jest.fn(
  async (args: { where: { id: string }; data: Partial<CreatorRecord> }) => {
    const existing = creatorsDb.get(args.where.id);
    if (!existing) throw new Error("Not found");
    const updated = { ...existing, ...args.data };
    creatorsDb.set(args.where.id, updated);
    return updated;
  },
);

const creatorDeleteMock = jest.fn(async (args: { where: { id: string } }) => {
  creatorsDb.delete(args.where.id);
  return {};
});
const transactionMock = jest.fn(
  async (callback: (tx: Record<string, unknown>) => Promise<unknown>) =>
    await callback({
      creator: {
        findUnique: findUniqueMock,
        delete: creatorDeleteMock,
      },
      notification: { deleteMany: jest.fn(async () => ({ count: 0 })) },
      webhook: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      webhookDelivery: { deleteMany: jest.fn(async () => ({ count: 0 })) },
      releasedSlug: { upsert: jest.fn(async () => ({})) },
    }),
);
const tipUpdateManyMock = jest.fn(async () => ({ count: 0 }));
const revokedCreatorIds = new Set<string>();
// authRoutes registers the shared Redis-backed rate limiter.
const rateLimitRedis = createRateLimitRedisMock();

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    $transaction: transactionMock,
    creator: {
      findUnique: findUniqueMock,
      update: updateMock,
      delete: creatorDeleteMock,
    },
    // The claim below releases the initial slug; hold checks and the
    // release upsert both run against this table.
    releasedSlug: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => null),
    },
    tip: { updateMany: tipUpdateManyMock },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
  consumeAuthNonce: jest.fn(async () => null),
  setAuthNonce: jest.fn(async () => undefined),
  cacheInvalidate: jest.fn(async () => undefined),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  revokeCreatorTokens: jest.fn(async (creatorId: string) => {
    revokedCreatorIds.add(creatorId);
  }),
  areCreatorTokensRevoked: jest.fn(async (creatorId: string) =>
    revokedCreatorIds.has(creatorId),
  ),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { authRoutes } = await import("../../modules/auth/auth.routes.js");
const { creatorRoutes } =
  await import("../../modules/creator/creator.routes.js");
const { authenticate } = await import("../../modules/auth/authenticate.js");
const { claimSlug, deleteCreator } =
  await import("../../modules/creator/creator.service.js");

describe("GET /auth/me fresh slug and authentication", () => {
  let app: FastifyInstance;
  const CREATOR_ID = "creator_123";
  const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  const INITIAL_SLUG = "user_1a2b3c4d";

  beforeEach(async () => {
    tipUpdateManyMock.mockClear();
    revokedCreatorIds.clear();
    creatorsDb = new Map<string, CreatorRecord>();
    creatorsDb.set(CREATOR_ID, {
      id: CREATOR_ID,
      walletAddress: WALLET,
      slug: INITIAL_SLUG,
      jarId: `@${INITIAL_SLUG}`,
      emailVerifiedAt: null,
      displayName: null,
      bio: null,
      splits: [],
    });

    app = Fastify();
    await app.register(jwtPlugin, {
      secret: "test-secret-at-least-32-chars-long-123456",
    });

    app.decorate("authenticate", authenticate);

    await app.register(authRoutes);
    await app.register(creatorRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns current slug from database after claiming a new slug using original session token", async () => {
    // Mint token with the placeholder initial slug
    const token = app.jwt.sign({
      sub: CREATOR_ID,
      wallet: WALLET,
      slug: INITIAL_SLUG,
    });

    // Initial check: should return INITIAL_SLUG
    const initialRes = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(initialRes.statusCode).toBe(200);
    expect(initialRes.json()).toEqual({
      user: {
        sub: CREATOR_ID,
        wallet: WALLET,
        slug: INITIAL_SLUG,
        emailVerifiedAt: null,
        // GET /me echoes the decoded token, which includes its issued-at.
        iat: expect.any(Number),
      },
    });

    expect(tipUpdateManyMock).not.toHaveBeenCalled();

    // Creator claims a real slug
    const claimedSlug = "alice_wonder";
    await claimSlug({ creatorId: CREATOR_ID, slug: claimedSlug });

    expect(tipUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(tipUpdateManyMock).toHaveBeenCalledWith({
      where: {
        jarId: `@${claimedSlug}`,
        creatorId: null,
      },
      data: {
        creatorId: CREATOR_ID,
      },
    });

    // Calling /auth/me with the SAME initial token must reflect the newly claimed slug
    const freshRes = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(freshRes.statusCode).toBe(200);
    expect(freshRes.json()).toEqual({
      user: {
        sub: CREATOR_ID,
        wallet: WALLET,
        slug: claimedSlug,
        emailVerifiedAt: null,
        // GET /me echoes the decoded token, which includes its issued-at.
        iat: expect.any(Number),
      },
    });
  });

  test("returns 401 when the creator no longer exists in the database", async () => {
    expect(tipUpdateManyMock).not.toHaveBeenCalled();
    const token = app.jwt.sign({
      sub: "creator_deleted_or_unknown",
      wallet: WALLET,
      slug: "ghost",
    });

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
      },
    });
  });

  test("rejects an existing token on a profile-write route immediately after deletion", async () => {
    const token = app.jwt.sign({
      sub: CREATOR_ID,
      wallet: WALLET,
      slug: INITIAL_SLUG,
    });

    await deleteCreator(CREATOR_ID);
    findUniqueMock.mockClear();
    updateMock.mockClear();

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Should not be written" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
