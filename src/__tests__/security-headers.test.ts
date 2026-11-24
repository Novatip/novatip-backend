/**
 * __tests__/security-headers.test.ts
 *
 * Verifies Helmet security headers, including an explicit restrictive
 * Content-Security-Policy for API-only responses (#368).
 */

import { jest } from "@jest/globals";
import type { FastifyInstance } from "fastify";
import { createRateLimitRedisMock } from "./helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["APP_BASE_URL"] ??= "http://localhost:3000";

const rateLimitRedis = createRateLimitRedisMock();

jest.unstable_mockModule("../db.js", () => ({
  db: {},
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../redis.js", () => ({
  redis: rateLimitRedis.redis,
  consumeAuthNonce: jest.fn(async () => null),
  setAuthNonce: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { buildServer } = await import("../server.js");

describe("Helmet security headers (#368)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
    await server.ready();
  });

  beforeEach(() => {
    rateLimitRedis.clear();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("includes an explicit restrictive Content-Security-Policy header on responses", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(res.statusCode).toBe(200);
    const csp = res.headers["content-security-policy"];
    expect(typeof csp).toBe("string");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
