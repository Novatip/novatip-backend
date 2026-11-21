import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const redisGetMock = jest.fn<(key: string) => Promise<string | null>>();
const redisSetMock =
  jest.fn<(key: string, value: string, ...args: string[]) => Promise<"OK">>();
const redisDelMock = jest.fn<(key: string) => Promise<number>>();
const creatorFindUniqueMock = jest.fn<() => Promise<unknown>>();

const redisClient = {
  get: redisGetMock,
  set: redisSetMock,
  del: redisDelMock,
  on: jest.fn(),
  quit: jest.fn(async () => "OK" as const),
};

jest.unstable_mockModule("ioredis", () => ({
  Redis: jest.fn(() => redisClient),
  default: jest.fn(() => redisClient),
}));
jest.unstable_mockModule("../../db.js", () => ({
  db: { creator: { findUnique: creatorFindUniqueMock } },
  disconnectDb: async (): Promise<void> => undefined,
}));
jest.unstable_mockModule("../../utils/logger.js", () => ({
  logger: {
    child: (): Record<string, unknown> => ({
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    }),
  },
}));

const { getCreatorBySlug } =
  await import("../../modules/creator/creator.service.js");

describe("creator lookup when Redis is unavailable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisGetMock.mockRejectedValue(new Error("Redis unavailable"));
    redisSetMock.mockRejectedValue(new Error("Redis unavailable"));
    creatorFindUniqueMock.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      bio: null,
      avatarUrl: null,
      jarId: "@alice",
      splits: [],
      createdAt: new Date("2026-10-20T00:00:00.000Z"),
    });
  });

  it("returns the database result when cache reads and writes fail", async () => {
    await expect(getCreatorBySlug("alice")).resolves.toMatchObject({
      id: "creator_1",
      slug: "alice",
    });

    expect(creatorFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "alice" } }),
    );
    expect(redisGetMock).toHaveBeenCalledWith("cache:creator:alice");
    expect(redisSetMock).toHaveBeenCalledWith(
      "cache:creator:alice",
      expect.any(String),
      "EX",
      60,
    );
  });

  it("returns 404 and does not cache when both cache and database miss", async () => {
    redisGetMock.mockResolvedValue(null);
    creatorFindUniqueMock.mockResolvedValue(null);

    await expect(getCreatorBySlug("missing")).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(redisSetMock).not.toHaveBeenCalled();
  });
});
