/**
 * __tests__/rate-limit-skip-on-error.test.ts
 *
 * Regression test for #290:
 * Ensures the global @fastify/rate-limit plugin in server.ts sets
 * skipOnError: true so a Redis outage does not turn every API request into a 500.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const rateLimitMock = jest.fn(
  (
    _key: string,
    _timeWindow: number,
    _max: number,
    _ban: number,
    _continueExceeding: boolean,
    callback: (error: Error | null, result?: [number, number, boolean]) => void,
  ) => {
    callback(new Error("Redis connection refused"));
  },
);

jest.unstable_mockModule("../redis.js", () => ({
  redis: {
    rateLimit: rateLimitMock,
  },
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  cacheInvalidate: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../db.js", () => ({
  db: {},
  disconnectDb: async (): Promise<void> => undefined,
}));

const { buildServer } = await import("../server.js");

describe("global rate limiter skipOnError (#290)", () => {
  beforeEach(() => {
    rateLimitMock.mockClear();
  });

  it("allows requests to complete when Redis rate-limit store fails", async () => {
    const server = await buildServer();

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health",
      });

      expect(rateLimitMock).toHaveBeenCalledTimes(1);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "ok",
      });
    } finally {
      await server.close();
    }
  });
});
