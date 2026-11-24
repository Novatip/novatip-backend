import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-characters-long";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["APP_BASE_URL"] = "https://app.novatip.xyz";
process.env["API_BASE_URL"] = "https://api.novatip.xyz";

interface CreatorRow {
  id: string;
  slug: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  email: string | null;
  emailVerifiedAt: Date | null;
}

const creator: CreatorRow = {
  id: "creator_email",
  slug: "alice",
  displayName: "Alice",
  bio: null,
  avatarUrl: null,
  email: null,
  emailVerifiedAt: null,
};

const findUniqueMock = jest.fn(async () => ({ email: creator.email }));
const updateMock = jest.fn(
  async (args: { data: Partial<CreatorRow> }) => {
    Object.assign(creator, args.data);
    return creator;
  },
);
const updateManyMock = jest.fn(
  async (args: {
    where: { id: string; email: string; emailVerifiedAt: null };
    data: { emailVerifiedAt: Date };
  }) => {
    if (
      creator.id !== args.where.id ||
      creator.email !== args.where.email ||
      creator.emailVerifiedAt !== null
    ) {
      return { count: 0 };
    }
    creator.emailVerifiedAt = args.data.emailVerifiedAt;
    return { count: 1 };
  },
);
const sendEmailVerificationEmailMock = jest.fn(
  async (_email: string, _url: string) => undefined,
);

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: findUniqueMock,
      update: updateMock,
      updateMany: updateManyMock,
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));
jest.unstable_mockModule("../../redis.js", () => ({
  areCreatorTokensRevoked: jest.fn(async () => false),
  cacheInvalidate: jest.fn(async () => undefined),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  revokeCreatorTokens: jest.fn(async () => undefined),
}));
jest.unstable_mockModule(
  "../../modules/notifications/email.service.js",
  () => ({
    sendEmailVerificationEmail: sendEmailVerificationEmailMock,
  }),
);

const { creatorRoutes } = await import(
  "../../modules/creator/creator.routes.js"
);
const { resetEmailVerificationCooldown } = await import(
  "../../modules/creator/creator.service.js"
);
const { authenticate } = await import("../../modules/auth/authenticate.js");

describe("creator email verification", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetEmailVerificationCooldown();
    Object.assign(creator, {
      email: null,
      emailVerifiedAt: null,
    });
    app = Fastify();
    await app.register(jwtPlugin, {
      secret: "test-secret-at-least-32-characters-long",
    });
    app.decorate("authenticate", authenticate);
    await app.register(creatorRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function updateEmail(email: string) {
    const token = app.jwt.sign({
      sub: creator.id,
      wallet: "Gwallet",
      slug: creator.slug,
    });
    return app.inject({
      method: "PATCH",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { email },
    });
  }

  it("verifies the current address from the signed confirmation link", async () => {
    const response = await updateEmail("alice@example.com");
    expect(response.statusCode).toBe(200);
    expect(creator.emailVerifiedAt).toBeNull();

    const link = sendEmailVerificationEmailMock.mock.calls[0]?.[1];
    if (!link) throw new Error("Verification email was not requested");
    const url = new URL(link);
    // The test app mounts creatorRoutes without the /api/v1/creators prefix.
    const path = url.pathname.replace(/^\/api\/v1\/creators/, "");
    const confirmation = await app.inject({
      method: "GET",
      url: `${path}${url.search}`,
    });

    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.json()).toEqual({ verified: true });
    expect(creator.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("does not trigger repeated sends when repeatedly calling PATCH /me with the same unverified email", async () => {
    const email = "alice@example.com";
    const res1 = await updateEmail(email);
    expect(res1.statusCode).toBe(200);
    expect(sendEmailVerificationEmailMock).toHaveBeenCalledTimes(1);

    const res2 = await updateEmail(email);
    expect(res2.statusCode).toBe(200);
    expect(sendEmailVerificationEmailMock).toHaveBeenCalledTimes(1);
  });

  it("verifies a valid signed token and records the verification", async () => {
    const email = "alice@example.com";
    creator.email = email;
    const token = app.jwt.sign(
      {
        sub: creator.id,
        email,
        purpose: "creator-email-verification",
      },
      { expiresIn: "24h" },
    );

    const response = await app.inject({
      method: "GET",
      url: `/email/verify?token=${encodeURIComponent(token)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ verified: true });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: creator.id, email, emailVerifiedAt: null },
      data: { emailVerifiedAt: expect.any(Date) },
    });
    expect(creator.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("rejects an expired confirmation token", async () => {
    const email = "alice@example.com";
    creator.email = email;
    const token = app.jwt.sign(
      {
        sub: creator.id,
        email,
        purpose: "creator-email-verification",
      },
      { expiresIn: "1s" },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const response = await app.inject({
      method: "GET",
      url: `/email/verify?token=${encodeURIComponent(token)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_EMAIL_VERIFICATION_TOKEN" },
    });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("does not accept a verification token as an authenticated creator session", async () => {
    const token = app.jwt.sign(
      {
        sub: creator.id,
        email: "alice@example.com",
        purpose: "creator-email-verification",
      },
      { expiresIn: "24h" },
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Should not be written" },
    });

    expect(response.statusCode).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
