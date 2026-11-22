import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const findCreatorMock =
  jest.fn<
    (args: {
      where: { id: string };
      select: { slug: true };
    }) => Promise<{ slug: string } | null>
  >();
const deleteCreatorMock =
  jest.fn<(args: { where: { id: string } }) => Promise<unknown>>();
const deleteNotificationsMock =
  jest.fn<
    (args: { where: { creatorId: string } }) => Promise<{ count: number }>
  >();
const findWebhooksMock =
  jest.fn<
    (args: {
      where: { creatorId: string };
      select: { id: true };
    }) => Promise<Array<{ id: string }>>
  >();
const deleteDeliveriesMock =
  jest.fn<
    (args: {
      where: { webhookId: { in: string[] } };
    }) => Promise<{ count: number }>
  >();
const deleteWebhooksMock =
  jest.fn<
    (args: { where: { creatorId: string } }) => Promise<{ count: number }>
  >();
const releasedSlugUpsertMock = jest.fn(async () => ({}));
const cacheInvalidateMock = jest.fn<(key: string) => Promise<void>>();
const revokeCreatorTokensMock =
  jest.fn<(creatorId: string) => Promise<void>>();

const tx = {
  creator: {
    findUnique: findCreatorMock,
    delete: deleteCreatorMock,
  },
  notification: { deleteMany: deleteNotificationsMock },
  webhook: {
    findMany: findWebhooksMock,
    deleteMany: deleteWebhooksMock,
  },
  webhookDelivery: { deleteMany: deleteDeliveriesMock },
  releasedSlug: { upsert: releasedSlugUpsertMock },
};
const transactionMock = jest.fn(
  async (callback: (transaction: typeof tx) => Promise<unknown>) =>
    await callback(tx),
);

jest.unstable_mockModule("../../db.js", () => ({
  db: { $transaction: transactionMock },
}));
jest.unstable_mockModule("../../redis.js", () => ({
  cacheInvalidate: cacheInvalidateMock,
  revokeCreatorTokens: revokeCreatorTokensMock,
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
}));

const { deleteCreator } =
  await import("../../modules/creator/creator.service.js");

const CREATOR_ID = "creator_123";

beforeEach(() => {
  jest.clearAllMocks();
  findCreatorMock.mockResolvedValue({ slug: "alice" });
  deleteCreatorMock.mockResolvedValue({});
  deleteNotificationsMock.mockResolvedValue({ count: 2 });
  findWebhooksMock.mockResolvedValue([
    { id: "webhook_1" },
    { id: "webhook_2" },
  ]);
  deleteDeliveriesMock.mockResolvedValue({ count: 3 });
  deleteWebhooksMock.mockResolvedValue({ count: 2 });
  cacheInvalidateMock.mockResolvedValue(undefined);
  revokeCreatorTokensMock.mockResolvedValue(undefined);
});

describe("deleteCreator", () => {
  it("deletes owned data transactionally and holds the deleted profile slug", async () => {
    await deleteCreator(CREATOR_ID);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(findCreatorMock).toHaveBeenCalledWith({
      where: { id: CREATOR_ID },
      select: { slug: true },
    });
    expect(deleteNotificationsMock).not.toHaveBeenCalled();
    expect(findWebhooksMock).toHaveBeenCalledWith({
      where: { creatorId: CREATOR_ID },
      select: { id: true },
    });
    expect(deleteDeliveriesMock).toHaveBeenCalledWith({
      where: { webhookId: { in: ["webhook_1", "webhook_2"] } },
    });
    expect(deleteWebhooksMock).toHaveBeenCalledWith({
      where: { creatorId: CREATOR_ID },
    });
    expect(releasedSlugUpsertMock).toHaveBeenCalledWith({
      where: { slug: "alice" },
      create: {
        slug: "alice",
        previousOwnerId: null,
        releasedAt: expect.any(Date),
      },
      update: { previousOwnerId: null, releasedAt: expect.any(Date) },
    });
    expect(deleteCreatorMock).toHaveBeenCalledWith({
      where: { id: CREATOR_ID },
    });
    expect(cacheInvalidateMock).toHaveBeenCalledWith("creator:alice");
    expect(revokeCreatorTokensMock).toHaveBeenCalledWith(CREATOR_ID);

    expect(deleteDeliveriesMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteWebhooksMock.mock.invocationCallOrder[0]!,
    );
    expect(deleteWebhooksMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCreatorMock.mock.invocationCallOrder[0]!,
    );
  });

  it("deletes a creator with no webhooks without issuing an empty delivery delete", async () => {
    findWebhooksMock.mockResolvedValue([]);

    await deleteCreator(CREATOR_ID);

    expect(deleteDeliveriesMock).not.toHaveBeenCalled();
    expect(deleteWebhooksMock).toHaveBeenCalledWith({
      where: { creatorId: CREATOR_ID },
    });
    expect(deleteCreatorMock).toHaveBeenCalledWith({
      where: { id: CREATOR_ID },
    });
  });

  it("returns 404 without changing anything when the creator does not exist", async () => {
    findCreatorMock.mockResolvedValue(null);

    await expect(deleteCreator(CREATOR_ID)).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(deleteNotificationsMock).not.toHaveBeenCalled();
    expect(findWebhooksMock).not.toHaveBeenCalled();
    expect(deleteCreatorMock).not.toHaveBeenCalled();
    expect(releasedSlugUpsertMock).not.toHaveBeenCalled();
    expect(cacheInvalidateMock).not.toHaveBeenCalled();
    expect(revokeCreatorTokensMock).not.toHaveBeenCalled();
  });
});
