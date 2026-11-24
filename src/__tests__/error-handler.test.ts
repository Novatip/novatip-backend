import type { FastifyInstance } from "fastify";
import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

jest.unstable_mockModule("../modules/creator/creator.routes.js", () => ({
  creatorRoutes: async () => undefined,
}));

const { buildServer } = await import("../server.js");

describe("global error handler", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
    server.get(
      "/test-bad-request",
      { config: { rateLimit: false } },
      async () => {
        throw Object.assign(new Error("Invalid input"), {
          statusCode: 400,
        });
      },
    );
    server.get(
      "/test-client-error",
      { config: { rateLimit: false } },
      async () => {
        throw Object.assign(new Error("Missing test resource"), {
          statusCode: 404,
        });
      },
    );
    server.get(
      "/test-conflict",
      { config: { rateLimit: false } },
      async () => {
        throw Object.assign(new Error("Slug already taken"), {
          statusCode: 409,
        });
      },
    );
    server.get(
      "/test-server-error",
      { config: { rateLimit: false } },
      async () => {
        throw new Error("Unexpected test failure");
      },
    );
    await server.ready();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it("logs 400, 404, and 409 client errors at warn and never at error level", async () => {
    const warn = jest.spyOn(server.log, "warn");
    const error = jest.spyOn(server.log, "error");

    const cases = [
      { url: "/test-bad-request", statusCode: 400, message: "Invalid input" },
      { url: "/test-client-error", statusCode: 404, message: "Missing test resource" },
      { url: "/test-conflict", statusCode: 409, message: "Slug already taken" },
    ];

    for (const testCase of cases) {
      const response = await server.inject({
        method: "GET",
        url: testCase.url,
      });

      expect(response.statusCode).toBe(testCase.statusCode);
      expect(warn).toHaveBeenCalledWith(
        {
          err: expect.objectContaining({
            message: testCase.message,
          }),
          url: testCase.url,
        },
        "Client error",
      );
    }

    expect(error).not.toHaveBeenCalled();
  });

  it("logs 500 server errors at error level with their stack", async () => {
    const warn = jest.spyOn(server.log, "warn");
    const error = jest.spyOn(server.log, "error");

    const serverResponse = await server.inject({
      method: "GET",
      url: "/test-server-error",
    });

    expect(serverResponse.statusCode).toBe(500);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: "Unexpected test failure",
          stack: expect.stringContaining("Unexpected test failure"),
        }),
        url: "/test-server-error",
      },
      "Server error",
    );
  });
});
