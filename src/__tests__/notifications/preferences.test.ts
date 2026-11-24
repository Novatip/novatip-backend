/**
 * __tests__/notifications/preferences.test.ts
 *
 * GET/PATCH /notifications/preferences — the endpoints behind novatip-web's
 * Notification preferences card, which 404'd because the backend registered
 * no routes under /notifications.
 *
 * Covers, per the acceptance criteria:
 * - Defaults: a creator migrated with the new columns reads both flags on
 * - Partial update: naming one channel leaves the other untouched
 * - Full update: both flags in one PATCH
 * - Validation: a present flag that isn't a boolean is a 400 naming the
 *   field, not a coerced write and not a 500
 * Plus: 401 without a token, and an empty preferences object as a no-op.
 *
 * db is mocked; no PostgreSQL is required. config.ts validates required env
 * vars at module load, so those are set before the module graph is imported.
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

const CREATOR = "creator_prefs";
const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

interface FakeCreatorRow {
  id: string;
  emailEnabled: boolean;
  webhookEnabled: boolean;
}

let creators = new Map<string, FakeCreatorRow>();

function pick(
  row: FakeCreatorRow,
  select: Record<string, boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(select)) {
    if (val) out[key] = row[key as keyof FakeCreatorRow];
  }
  return out;
}

const findUniqueMock = jest.fn(
  async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
    const creator = creators.get(args.where.id);
    if (!creator) return null;
    return args.select ? pick(creator, args.select) : creator;
  },
);

const updateMock = jest.fn(
  async (args: {
    where: { id: string };
    data: Partial<FakeCreatorRow>;
    select?: Record<string, boolean>;
  }) => {
    const existing = creators.get(args.where.id);
    if (!existing) throw new Error("Record to update not found.");
    const updated = { ...existing, ...args.data };
    creators.set(args.where.id, updated);
    return args.select ? pick(updated, args.select) : updated;
  },
);

jest.unstable_mockModule("../../db.js", () => ({
  db: { creator: { findUnique: findUniqueMock, update: updateMock } },
  disconnectDb: async (): Promise<void> => undefined,
}));

const { notificationRoutes } =
  await import("../../modules/notifications/notifications.routes.js");

let app: FastifyInstance;

function authHeaders(): { authorization: string } {
  const token = app.jwt.sign({ sub: CREATOR, wallet: WALLET, slug: "prefs" });
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  jest.clearAllMocks();
  // Both flags true: the shape the migration's DEFAULT true backfills every
  // pre-existing creator into.
  creators = new Map();
  creators.set(CREATOR, {
    id: CREATOR,
    emailEnabled: true,
    webhookEnabled: true,
  });

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
  await app.register(notificationRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ── GET: defaults ─────────────────────────────────────────────────────────────

describe("GET /preferences", () => {
  test("returns both flags on for a creator with migration defaults", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/preferences",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      preferences: { emailEnabled: true, webhookEnabled: true },
    });
  });

  test("returns flags as they were last stored", async () => {
    creators.set(CREATOR, {
      id: CREATOR,
      emailEnabled: false,
      webhookEnabled: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/preferences",
      headers: authHeaders(),
    });

    expect(res.json()).toEqual({
      preferences: { emailEnabled: false, webhookEnabled: true },
    });
  });

  test("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/preferences" });
    expect(res.statusCode).toBe(401);
  });
});

// ── PATCH: partial and full updates ───────────────────────────────────────────

describe("PATCH /preferences", () => {
  test("updates one channel and leaves the other untouched", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/preferences",
      headers: authHeaders(),
      payload: { preferences: { emailEnabled: false } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      preferences: { emailEnabled: false, webhookEnabled: true },
    });

    // The write names only the supplied flag: a partial PATCH must not
    // rewrite the channel the card didn't touch.
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: CREATOR },
      data: { emailEnabled: false },
      select: { emailEnabled: true, webhookEnabled: true },
    });
    expect(creators.get(CREATOR)).toMatchObject({
      emailEnabled: false,
      webhookEnabled: true,
    });
  });

  test("updates the webhook channel alone", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/preferences",
      headers: authHeaders(),
      payload: { preferences: { webhookEnabled: false } },
    });

    expect(res.json()).toEqual({
      preferences: { emailEnabled: true, webhookEnabled: false },
    });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: CREATOR },
      data: { webhookEnabled: false },
      select: { emailEnabled: true, webhookEnabled: true },
    });
  });

  test("updates both channels in one call", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/preferences",
      headers: authHeaders(),
      payload: { preferences: { emailEnabled: false, webhookEnabled: false } },
    });

    expect(res.json()).toEqual({
      preferences: { emailEnabled: false, webhookEnabled: false },
    });
  });

  test("an empty preferences object is a no-op that returns the pair", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/preferences",
      headers: authHeaders(),
      payload: { preferences: {} },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      preferences: { emailEnabled: true, webhookEnabled: true },
    });
    expect(creators.get(CREATOR)).toMatchObject({
      emailEnabled: true,
      webhookEnabled: true,
    });
  });

  test("requires authentication", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/preferences",
      payload: { preferences: { emailEnabled: false } },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── PATCH: validation ─────────────────────────────────────────────────────────

describe("PATCH /preferences validation", () => {
  test.each([
    ["a string flag", { preferences: { emailEnabled: "true" } }],
    ["a numeric flag", { preferences: { webhookEnabled: 1 } }],
    ["a null flag", { preferences: { emailEnabled: null } }],
    [
      "a non-boolean inside both",
      { preferences: { emailEnabled: true, webhookEnabled: "yes" } },
    ],
    ["a non-object preferences", { preferences: "on" }],
    ["a missing preferences key", { emailEnabled: false }],
  ])("rejects %s with a 400 and writes nothing", async (_label, payload) => {
    const res = await app.inject({
      method: "PATCH",
      url: "/preferences",
      headers: authHeaders(),
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
    expect(creators.get(CREATOR)).toMatchObject({
      emailEnabled: true,
      webhookEnabled: true,
    });
  });
});

// ── PATCH: 404 for missing creator ────────────────────────────────────────────

describe("PATCH /preferences with nonexistent creator", () => {
  test("returns 404 when the creator no longer exists", async () => {
    // Remove the creator to simulate a stale JWT
    creators.delete(CREATOR);

    const res = await app.inject({
      method: "PATCH",
      url: "/preferences",
      headers: authHeaders(),
      payload: { preferences: { emailEnabled: false } },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBeDefined();
  });

  test("404 matches the GET behavior for consistency", async () => {
    creators.delete(CREATOR);

    const getRes = await app.inject({
      method: "GET",
      url: "/preferences",
      headers: authHeaders(),
    });

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/preferences",
      headers: authHeaders(),
      payload: { preferences: { emailEnabled: false } },
    });

    expect(getRes.statusCode).toBe(404);
    expect(patchRes.statusCode).toBe(404);
  });
});
