import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["EMAIL_VERIFICATION_RATE_LIMIT"] = "2";

const rateLimitRedis = createRateLimitRedisMock();

const creator = {
  id: "creator_rate_limit",
  slug: "alice",
  displayName: "Alice",
  bio: null,
  avatarUrl: null,
  email: null,
  emailVerifiedAt: null,
};

const updateProfileMock = jest.fn(
  async (args: {
    creatorId: string;
    displayName?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
    email?: string | null;
  }) => {
    Object.assign(creator, args);
    return creator;
  },
);

const sendEmailVerificationEmailMock = jest.fn(async () => undefined);

jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  updateProfile: updateProfileMock,
  getCreatorBySlug: jest.fn(),
  claimSlug: jest.fn(),
  renameSlug: jest.fn(),
  updateCreatorSplits: jest.fn(),
  isSlugAvailable: jest.fn(),
  deleteCreator: jest.fn(),
  isEmailVerificationInCooldown: jest.fn(async () => false),
  recordEmailVerificationCooldown: jest.fn(async () => undefined),
  resetEmailVerificationCooldown: jest.fn(),
}));

jest.unstable_mockModule(
  "../../modules/notifications/email.service.js",
  () => ({
    sendEmailVerificationEmail: sendEmailVerificationEmailMock,
  }),
);

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: jest.fn(async () => ({ email: creator.email })),
      update: jest.fn(async () => creator),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
  areCreatorTokensRevoked: jest.fn(async () => false),
  cacheInvalidate: jest.fn(async () => undefined),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  revokeCreatorTokens: jest.fn(async () => undefined),
}));

const { creatorRoutes } = await import(
  "../../modules/creator/creator.routes.js"
);
const { authenticate } = await import("../../modules/auth/authenticate.js");

describe("PATCH /me email verification rate limit", () => {
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimitRedis.clear();
  });

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(jwtPlugin, {
      secret: "test-secret-at-least-32-chars-long-123456",
    });
    app.decorate("authenticate", authenticate);
    app.setErrorHandler((error, _request, reply) => {
      reply.status(error.statusCode ?? 500).send({
        error: {
          code: error.code ?? "INTERNAL_SERVER_ERROR",
          message: error.message,
        },
      });
    });
    await app.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
      redis: rateLimitRedis.redis,
    });
    await app.register(creatorRoutes);
    await app.ready();
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("enforces dedicated rate limit on email verification triggering path", async () => {
    const app = await buildApp();
    const token = app.jwt.sign({
      sub: creator.id,
      wallet: "Gwallet",
      slug: creator.slug,
    });

    const sendEmailUpdate = () =>
      app.inject({
        method: "PATCH",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
        payload: { email: "new@example.com" },
      });

    // Request 1: succeeds
    const first = await sendEmailUpdate();
    expect(first.statusCode).toBe(200);

    // Request 2: succeeds (limit is 2)
    const second = await sendEmailUpdate();
    expect(second.statusCode).toBe(200);

    // Request 3: rate limited
    const third = await sendEmailUpdate();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({
      error: {
        code: "EMAIL_VERIFICATION_RATE_LIMITED",
        message: "Too many email verification requests. Try again in a minute.",
      },
    });

    // Namespace check in Redis
    const emailCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("novatip-creator-email-verification-rate-limit-"),
    );
    expect(emailCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not rate limit profile updates that omit email", async () => {
    const app = await buildApp();
    const token = app.jwt.sign({
      sub: creator.id,
      wallet: "Gwallet",
      slug: creator.slug,
    });

    for (let i = 0; i < 5; i++) {
      const response = await app.inject({
        method: "PATCH",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: `Alice ${i}` },
      });
      expect(response.statusCode).toBe(200);
    }

    const emailCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith("novatip-creator-email-verification-rate-limit-"),
    );
    expect(emailCalls).toHaveLength(0);
  });
});
