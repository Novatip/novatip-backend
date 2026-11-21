/**
 * __tests__/webhooks/webhooks-routes.test.ts
 *
 * HTTP-layer coverage for every webhooks.routes.ts handler. The rest of this
 * directory tests webhooks.service.ts directly; these tests mock the service
 * and pin down what lives in the route file itself:
 * - zod 400 on each route that takes a body or query
 * - 404 WEBHOOK_NOT_FOUND when the service reports missing / not owned
 * - the success status code (200, 201 on create, 204 on delete)
 * - the per-route 10 req/min rate limit on POST /:id/ping
 *
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
import rateLimit from "@fastify/rate-limit";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR = "creator_webhook_routes";
const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const WEBHOOK_ID = "wh_1";
const SECRET = "s".repeat(32);

const webhook = {
  id: WEBHOOK_ID,
  url: "https://example.com/hook",
  enabled: true,
};
const delivery = { id: "del_1", success: true, statusCode: 200 };

const listWebhooksMock = jest.fn(async () => [webhook]);
const createWebhookMock = jest.fn(async () => webhook);
const setWebhookEnabledMock = jest.fn(
  async (): Promise<typeof webhook | null> => webhook,
);
const listWebhookDeliveriesMock = jest.fn(
  async (): Promise<(typeof delivery)[] | null> => [delivery],
);
const sendTestPingMock = jest.fn(
  async (): Promise<typeof delivery | null> => delivery,
);
const rotateWebhookSecretMock = jest.fn(
  async (): Promise<(typeof webhook & { secret: string }) | null> => ({
    ...webhook,
    secret: SECRET,
  }),
);
const deleteWebhookMock = jest.fn(async () => true);

jest.unstable_mockModule("../../modules/webhooks/webhooks.service.js", () => ({
  createWebhook: createWebhookMock,
  listWebhooks: listWebhooksMock,
  listWebhookDeliveries: listWebhookDeliveriesMock,
  sendTestPing: sendTestPingMock,
  setWebhookEnabled: setWebhookEnabledMock,
  rotateWebhookSecret: rotateWebhookSecretMock,
  deleteWebhook: deleteWebhookMock,
  generateWebhookSecret: () => SECRET,
  // Mirrors webhooks.service.ts — the route schemas read these bounds.
  MIN_WEBHOOK_SECRET_LENGTH: 16,
  MAX_WEBHOOK_SECRET_LENGTH: 256,
  DEFAULT_DELIVERY_PAGE_SIZE: 20,
  MAX_DELIVERY_PAGE_SIZE: 100,
  DEFAULT_WEBHOOK_PAGE_SIZE: 50,
  MAX_WEBHOOK_PAGE_SIZE: 100,
}));

const { webhookRoutes } =
  await import("../../modules/webhooks/webhooks.routes.js");

const NOT_FOUND = {
  error: { code: "WEBHOOK_NOT_FOUND", message: "Webhook not found" },
};

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
  // In-memory store, same global budget as server.ts. Registered before the
  // routes so the ping route's config.rateLimit override is picked up.
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
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
  await app.register(webhookRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /", () => {
  it("returns 400 for an out-of-range limit", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?limit=500",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.limit).toBeDefined();
    expect(listWebhooksMock).not.toHaveBeenCalled();
  });

  it("returns 200 with the creator's webhooks", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?limit=10&offset=5",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ webhooks: [webhook] });
    expect(listWebhooksMock).toHaveBeenCalledWith(CREATOR, 10, 5);
  });

  it("returns 401 without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(401);
    expect(listWebhooksMock).not.toHaveBeenCalled();
  });
});

describe("POST /", () => {
  it("returns 400 for a non-https URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders(),
      payload: { url: "http://example.com/hook" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.url).toBeDefined();
    expect(createWebhookMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a secret below the minimum length", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders(),
      payload: { url: "https://example.com/hook", secret: "short" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.secret).toBeDefined();
  });

  it("accepts a secret at the maximum length", async () => {
    const secret = "s".repeat(256);
    createWebhookMock.mockResolvedValueOnce(webhook);

    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders(),
      payload: { url: "https://example.com/hook", secret },
    });

    expect(res.statusCode).toBe(201);
    expect(createWebhookMock).toHaveBeenCalledWith(
      CREATOR,
      "https://example.com/hook",
      secret,
    );
  });

  it("returns 400 naming the maximum length when a secret is too long", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders(),
      payload: { url: "https://example.com/hook", secret: "s".repeat(257) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.secret.join(" ")).toContain("256");
    expect(createWebhookMock).not.toHaveBeenCalled();
  });

  it("returns 201 with the webhook and its secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders(),
      payload: { url: "https://example.com/hook" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ webhook: { ...webhook, secret: SECRET } });
    const created = res.json().webhook as Record<string, unknown>;
    const listedResponse = await app.inject({
      method: "GET",
      url: "/",
      headers: authHeaders(),
    });
    const listed = listedResponse.json().webhooks[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(created).sort()).toEqual(
      [...Object.keys(listed), "secret"].sort(),
    );
    expect(created).not.toHaveProperty("creatorId");
    expect(createWebhookMock).toHaveBeenCalledWith(
      CREATOR,
      "https://example.com/hook",
      SECRET,
    );
  });
});

describe("PATCH /:id", () => {
  it("returns 400 when enabled is not a boolean", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/${WEBHOOK_ID}`,
      headers: authHeaders(),
      payload: { enabled: "no" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.enabled).toBeDefined();
    expect(setWebhookEnabledMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or not-owned webhook", async () => {
    setWebhookEnabledMock.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/wh_missing",
      headers: authHeaders(),
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  });

  it("returns 200 with the updated webhook", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/${WEBHOOK_ID}`,
      headers: authHeaders(),
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ webhook });
    expect(setWebhookEnabledMock).toHaveBeenCalledWith(
      CREATOR,
      WEBHOOK_ID,
      false,
    );
  });
});

describe("GET /:id/deliveries", () => {
  it("returns 400 for an invalid success filter", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/${WEBHOOK_ID}/deliveries?success=maybe`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.success).toBeDefined();
    expect(listWebhookDeliveriesMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or not-owned webhook", async () => {
    listWebhookDeliveriesMock.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "GET",
      url: "/wh_missing/deliveries",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  });

  it("returns 200 with the delivery page", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/${WEBHOOK_ID}/deliveries?limit=5&offset=10&success=false`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deliveries: [delivery] });
    expect(listWebhookDeliveriesMock).toHaveBeenCalledWith(
      CREATOR,
      WEBHOOK_ID,
      5,
      10,
      false,
    );
  });
});

describe("POST /:id/ping", () => {
  it("returns 404 for a missing or not-owned webhook", async () => {
    sendTestPingMock.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "POST",
      url: "/wh_missing/ping",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  });

  it("returns 200 with the delivery", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/${WEBHOOK_ID}/ping`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivery });
    expect(sendTestPingMock).toHaveBeenCalledWith(CREATOR, WEBHOOK_ID);
  });

  it("returns 429 on the 11th request within a minute", async () => {
    const headers = authHeaders();

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/${WEBHOOK_ID}/ping`,
        headers,
      });
      expect(res.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: "POST",
      url: `/${WEBHOOK_ID}/ping`,
      headers,
    });

    expect(limited.statusCode).toBe(429);
    expect(sendTestPingMock).toHaveBeenCalledTimes(10);

    // The override is scoped to ping — the global 100/min budget still
    // leaves the other routes reachable.
    const list = await app.inject({ method: "GET", url: "/", headers });
    expect(list.statusCode).toBe(200);
  });
});

describe("POST /:id/secret", () => {
  it("returns 400 for a secret below the minimum length", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/${WEBHOOK_ID}/secret`,
      headers: authHeaders(),
      payload: { secret: "short" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.secret).toBeDefined();
    expect(rotateWebhookSecretMock).not.toHaveBeenCalled();
  });

  it("accepts a secret at the maximum length", async () => {
    const secret = "s".repeat(256);
    const res = await app.inject({
      method: "POST",
      url: `/${WEBHOOK_ID}/secret`,
      headers: authHeaders(),
      payload: { secret },
    });

    expect(res.statusCode).toBe(200);
    expect(rotateWebhookSecretMock).toHaveBeenCalledWith(
      CREATOR,
      WEBHOOK_ID,
      secret,
    );
  });

  it("returns 400 naming the maximum length when a secret is too long", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/${WEBHOOK_ID}/secret`,
      headers: authHeaders(),
      payload: { secret: "s".repeat(257) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.secret.join(" ")).toContain("256");
    expect(rotateWebhookSecretMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or not-owned webhook", async () => {
    rotateWebhookSecretMock.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "POST",
      url: "/wh_missing/secret",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  });

  it("returns 200 with the rotated secret when no body is sent", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/${WEBHOOK_ID}/secret`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ webhook: { ...webhook, secret: SECRET } });
    expect(rotateWebhookSecretMock).toHaveBeenCalledWith(
      CREATOR,
      WEBHOOK_ID,
      SECRET,
    );
  });
});

describe("DELETE /:id", () => {
  it("returns 404 for a missing or not-owned webhook", async () => {
    deleteWebhookMock.mockResolvedValueOnce(false);

    const res = await app.inject({
      method: "DELETE",
      url: "/wh_missing",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  });

  it("returns 204 with an empty body", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/${WEBHOOK_ID}`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(deleteWebhookMock).toHaveBeenCalledWith(CREATOR, WEBHOOK_ID);
  });
});
