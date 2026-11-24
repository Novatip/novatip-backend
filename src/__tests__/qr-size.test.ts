import Fastify from "fastify";
import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const qrToBufferMock = jest.fn<() => Promise<Buffer>>();
const getCreatorBySlugMock = jest.fn<() => Promise<{ slug: string }>>();

jest.unstable_mockModule("qrcode", () => ({
  default: {
    toBuffer: qrToBufferMock,
    toString: jest.fn(),
  },
}));
jest.unstable_mockModule("../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: getCreatorBySlugMock,
}));

const { qrRoutes } = await import("../modules/qr/qr.routes.js");

describe("GET /qr/:slug/png width", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(qrRoutes, { prefix: "/qr" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getCreatorBySlugMock.mockResolvedValue({ slug: "alice" });
    qrToBufferMock.mockResolvedValue(Buffer.from("png"));
  });

  it("defaults to 512 pixels", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/qr/alice/png",
    });

    expect(response.statusCode).toBe(200);
    expect(qrToBufferMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ width: 512 }),
    );
  });

  it.each(["256", "1024", "2048"])(
    "accepts width %s and passes it to the renderer",
    async (width) => {
      const response = await app.inject({
        method: "GET",
        url: `/qr/alice/png?width=${width}`,
      });

      expect(response.statusCode).toBe(200);
      expect(qrToBufferMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ width: Number(width) }),
      );
    },
  );

  it.each(["abc", "255", "2049", "512.5"])(
    "rejects invalid width %s with a clear 400",
    async (width) => {
      const response = await app.inject({
        method: "GET",
        url: `/qr/alice/png?width=${width}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          fieldErrors: {
            width: expect.arrayContaining([expect.any(String)]),
          },
        },
      });
      expect(getCreatorBySlugMock).not.toHaveBeenCalled();
      expect(qrToBufferMock).not.toHaveBeenCalled();
    },
  );
});
