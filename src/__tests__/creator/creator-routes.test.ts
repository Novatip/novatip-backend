/**
 * __tests__/creator/creator-routes.test.ts
 *
 * HTTP-layer coverage for the creator.routes.ts handlers whose services are
 * otherwise only tested directly:
 * - POST   /claim                — zod 400, 201 on success
 * - PATCH  /me/slug              — zod 400, 200 on success
 * - DELETE /me                   — 204 with an empty body
 * - PATCH  /tips/:tipId/message  — zod 400, structured 404, 200 on success
 *
 * The services are mocked so these tests pin down only what lives in the
 * route file itself: body parsing, status codes and response shapes.
 * config.ts validates required env vars at module load, so those are set
 * before the module graph is imported.
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

const CREATOR = "creator_routes_test";
const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

const claimSlugMock = jest.fn(async (input: { slug: string }) => ({
  id: CREATOR,
  slug: input.slug,
}));
const renameSlugMock = jest.fn(async (input: { slug: string }) => ({
  id: CREATOR,
  slug: input.slug,
}));
const deleteCreatorMock = jest.fn(async () => undefined);
const setTipMessageHiddenMock = jest.fn(
  async (
    _creatorId: string,
    tipId: string,
    hidden: boolean,
  ): Promise<{ id: string; messageHidden: boolean } | null> => ({
    id: tipId,
    messageHidden: hidden,
  }),
);

jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: jest.fn(),
  claimSlug: claimSlugMock,
  renameSlug: renameSlugMock,
  updateProfile: jest.fn(),
  updateCreatorSplits: jest.fn(),
  isSlugAvailable: jest.fn(),
  deleteCreator: deleteCreatorMock,
}));

jest.unstable_mockModule("../../modules/creator/messages.service.js", () => ({
  setTipMessageHidden: setTipMessageHiddenMock,
}));

jest.unstable_mockModule("../../db.js", () => ({
  db: {},
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule(
  "../../modules/notifications/email.service.js",
  () => ({
    sendEmailVerificationEmail: jest.fn(async () => undefined),
  }),
);

jest.unstable_mockModule("../../redis.js", () => ({
  cacheInvalidate: jest.fn(async () => undefined),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  revokeCreatorTokens: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { creatorRoutes } =
  await import("../../modules/creator/creator.routes.js");

let app: FastifyInstance;

function authHeaders(): { authorization: string } {
  const token = app.jwt.sign({ sub: CREATOR, wallet: WALLET, slug: "alice" });
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  jest.clearAllMocks();

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
          error: { code: "UNAUTHORIZED", message: "Authentication required." },
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

describe("POST /claim", () => {
  it("returns 400 for a slug that fails validation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      headers: authHeaders(),
      payload: { slug: "ab" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.slug).toBeDefined();
    expect(claimSlugMock).not.toHaveBeenCalled();
  });

  it("returns 201 with the claimed creator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      headers: authHeaders(),
      payload: { slug: "alice", displayName: "Alice" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ creator: { id: CREATOR, slug: "alice" } });
    expect(claimSlugMock).toHaveBeenCalledWith({
      creatorId: CREATOR,
      slug: "alice",
      displayName: "Alice",
    });
  });
});

describe("PATCH /me/slug", () => {
  it("returns 400 when the slug is missing", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/me/slug",
      headers: authHeaders(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.slug).toBeDefined();
    expect(renameSlugMock).not.toHaveBeenCalled();
  });

  it("returns 200 with the renamed creator", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/me/slug",
      headers: authHeaders(),
      payload: { slug: "alice_new" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      creator: { id: CREATOR, slug: "alice_new" },
    });
    expect(renameSlugMock).toHaveBeenCalledWith({
      creatorId: CREATOR,
      slug: "alice_new",
    });
  });
});

describe("DELETE /me", () => {
  it("returns 204 with an empty body", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/me",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(deleteCreatorMock).toHaveBeenCalledWith(CREATOR);
  });
});

describe("PATCH /tips/:tipId/message", () => {
  it("returns 400 when hidden is not a boolean", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/tips/tip_1/message",
      headers: authHeaders(),
      payload: { hidden: "yes" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.hidden).toBeDefined();
    expect(setTipMessageHiddenMock).not.toHaveBeenCalled();
  });

  it("returns 404 with the standard error envelope for a missing or not-owned tip", async () => {
    setTipMessageHiddenMock.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/tips/tip_missing/message",
      headers: authHeaders(),
      payload: { hidden: true },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("TIP_NOT_FOUND");
    expect(res.json()).toEqual({
      error: { code: "TIP_NOT_FOUND", message: "Tip not found" },
    });
  });

  it("returns 200 with the updated tip", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/tips/tip_1/message",
      headers: authHeaders(),
      payload: { hidden: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tip: { id: "tip_1", messageHidden: true } });
    expect(setTipMessageHiddenMock).toHaveBeenCalledWith(
      CREATOR,
      "tip_1",
      true,
    );
  });
});
