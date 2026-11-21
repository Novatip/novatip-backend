/**
 * __tests__/resolver/cache-control.test.ts
 *
 * GET /resolve/:slug hydrates every public tip page, so — like the QR and
 * public-feed endpoints — it must be cacheable by a browser or CDN. The
 * max-age is the server-side profile cache TTL, so a client never holds a
 * response longer than the server would.
 */

import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const PROFILE_CACHE_TTL = 60;
const getCreatorBySlugMock = jest.fn(async () => ({ slug: "alice" }));

jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: getCreatorBySlugMock,
  PROFILE_CACHE_TTL,
}));

const { resolverRoutes } =
  await import("../../modules/resolver/resolver.routes.js");

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  app = Fastify();
  await app.register(resolverRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /resolve/:slug", () => {
  it("sets a public Cache-Control header matching the profile cache TTL", async () => {
    const res = await app.inject({ method: "GET", url: "/alice" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(
      `public, max-age=${PROFILE_CACHE_TTL}`,
    );
  });

  it("does not mark a validation failure as cacheable", async () => {
    const res = await app.inject({ method: "GET", url: "/A!" });

    expect(res.statusCode).toBe(400);
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(getCreatorBySlugMock).not.toHaveBeenCalled();
  });
});
