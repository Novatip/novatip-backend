/**
 * __tests__/webhooks/ping-rate-limit.test.ts
 *
 * POST /:id/ping has a tighter per-route limit than the global one: it is the
 * one route where a caller picks a URL and has the server fetch it on demand,
 * so it must not work as a traffic amplifier against a third party. This
 * builds a real Fastify app with @fastify/rate-limit, the same way the QR and
 * auth rate-limit tests do, so a refactor that drops or widens the override
 * fails here instead of going unnoticed.
 */

import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const GLOBAL_MAX = 100;
const PING_KEY_PREFIX = "fastify-rate-limit-POST/webhooks/:id/ping-";

const rateLimitRedis = createRateLimitRedisMock();
const sendTestPingMock = jest.fn(async () => ({ id: "delivery_1" }));
const listWebhooksMock = jest.fn(async () => []);

jest.unstable_mockModule("../../modules/webhooks/webhooks.service.js", () => ({
  createWebhook: jest.fn(),
  listWebhooks: listWebhooksMock,
  listWebhookDeliveries: jest.fn(),
  sendTestPing: sendTestPingMock,
  setWebhookEnabled: jest.fn(),
  rotateWebhookSecret: jest.fn(),
  deleteWebhook: jest.fn(),
  generateWebhookSecret: jest.fn(),
  MIN_WEBHOOK_SECRET_LENGTH: 32,
  DEFAULT_DELIVERY_PAGE_SIZE: 20,
  MAX_DELIVERY_PAGE_SIZE: 100,
  DEFAULT_WEBHOOK_PAGE_SIZE: 20,
  MAX_WEBHOOK_PAGE_SIZE: 100,
}));

const { webhookRoutes, PING_RATE_LIMIT } =
  await import("../../modules/webhooks/webhooks.routes.js");

describe("POST /webhooks/:id/ping rate limit", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    rateLimitRedis.clear();

    app = Fastify();
    app.decorateRequest("user", null);
    app.decorate("authenticate", async (request) => {
      request.user = { sub: "creator_1", wallet: "GWALLET", slug: "alice" };
    });
    await app.register(rateLimit, {
      max: GLOBAL_MAX,
      timeWindow: "1 minute",
      redis: rateLimitRedis.redis,
    });
    await app.register(webhookRoutes, { prefix: "/webhooks" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function ping(id: string) {
    return app.inject({ method: "POST", url: `/webhooks/${id}/ping` });
  }

  it("is tighter than the global limit", () => {
    expect(PING_RATE_LIMIT).toBeGreaterThan(0);
    expect(PING_RATE_LIMIT).toBeLessThan(GLOBAL_MAX);
  });

  it("allows the configured number of pings, then returns 429 in the same window", async () => {
    for (let i = 0; i < PING_RATE_LIMIT; i++) {
      const response = await ping("wh_1");
      expect(response.statusCode).toBe(200);
    }

    const limited = await ping("wh_1");
    expect(limited.statusCode).toBe(429);
    expect(sendTestPingMock).toHaveBeenCalledTimes(PING_RATE_LIMIT);

    // The bucket is per route, not per webhook — switching ids is not a way
    // around it.
    const otherWebhook = await ping("wh_2");
    expect(otherWebhook.statusCode).toBe(429);
    expect(sendTestPingMock).toHaveBeenCalledTimes(PING_RATE_LIMIT);

    const pingCalls = rateLimitRedis.calls.filter((call) =>
      call.key.startsWith(PING_KEY_PREFIX),
    );
    expect(pingCalls).toHaveLength(PING_RATE_LIMIT + 2);
    expect(
      pingCalls.every(
        (call) => call.max === PING_RATE_LIMIT && call.timeWindow === 60_000,
      ),
    ).toBe(true);

    rateLimitRedis.advanceBy(60_000);
    const afterWindow = await ping("wh_1");
    expect(afterWindow.statusCode).toBe(200);
  });

  it("is independent of the global budget", async () => {
    for (let i = 0; i <= PING_RATE_LIMIT; i++) {
      await ping("wh_1");
    }
    expect((await ping("wh_1")).statusCode).toBe(429);

    // Pings draw only on their own bucket, never the global one...
    const globalCalls = () =>
      rateLimitRedis.calls.filter(
        (call) =>
          call.key.startsWith("fastify-rate-limit-") &&
          !call.key.startsWith(PING_KEY_PREFIX),
      );
    expect(globalCalls()).toHaveLength(0);

    // ...so the rest of the API stays available while pings are throttled.
    const list = await app.inject({ method: "GET", url: "/webhooks" });
    expect(list.statusCode).toBe(200);
    expect(listWebhooksMock).toHaveBeenCalledTimes(1);
    expect(globalCalls()).toHaveLength(1);
    expect(globalCalls()[0]?.max).toBe(GLOBAL_MAX);
  });
});
