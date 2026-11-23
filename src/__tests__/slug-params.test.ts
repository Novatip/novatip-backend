import Fastify from "fastify";
import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const creatorFindUniqueMock = jest.fn();
const tipFindManyMock = jest.fn();
const cacheGetMock = jest.fn(async () => null);
const cacheSetMock = jest.fn(async () => undefined);
const cacheInvalidateMock = jest.fn(async () => undefined);

jest.unstable_mockModule("../db.js", () => ({
  db: {
    creator: { findUnique: creatorFindUniqueMock },
    tip: { findMany: tipFindManyMock },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));
jest.unstable_mockModule("../redis.js", () => ({
  cacheGet: cacheGetMock,
  cacheSet: cacheSetMock,
  cacheInvalidate: cacheInvalidateMock,
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { creatorRoutes } = await import("../modules/creator/creator.routes.js");
const { resolverRoutes } =
  await import("../modules/resolver/resolver.routes.js");
const { qrRoutes } = await import("../modules/qr/qr.routes.js");
const { publicRoutes } = await import("../modules/public/public.routes.js");

describe("slug route parameter validation", () => {
  const app = Fastify();

  beforeAll(async () => {
    app.decorate("authenticate", async () => undefined);
    await app.register(creatorRoutes, { prefix: "/creators" });
    await app.register(resolverRoutes, { prefix: "/resolve" });
    await app.register(qrRoutes, { prefix: "/qr" });
    await app.register(publicRoutes, { prefix: "/public" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects malformed slugs on all six routes before cache or database access", async () => {
    const urls = [
      "/creators/!!",
      "/creators/check/!!",
      "/resolve/!!",
      "/qr/!!",
      "/qr/!!/png",
      "/public/!!/recent",
    ];

    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.any(Object) });
    }

    expect(cacheGetMock).not.toHaveBeenCalled();
    expect(creatorFindUniqueMock).not.toHaveBeenCalled();
    expect(tipFindManyMock).not.toHaveBeenCalled();
  });
});
