/**
 * __tests__/indexer/handle-event.test.ts
 *
 * Covers #278:
 * - handleEvent dispatches webhooks and email notifications exactly once for a
 *   genuinely new tip, and does not dispatch at all on replay of the same txHash.
 */

import { jest } from "@jest/globals";
import type { TipEvent } from "@novatip/sdk";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const tipStore = new Map<string, Record<string, unknown>>();

const findUniqueCreatorMock = jest.fn(async () => ({ id: "creator_1" }));
const createManyTipMock = jest.fn(
  async (args: { data: Array<Record<string, unknown>> }) => {
    let inserted = 0;
    for (const row of args.data) {
      const txHash = row["txHash"] as string;
      if (!tipStore.has(txHash)) {
        tipStore.set(txHash, row);
        inserted += 1;
      }
    }
    return { count: inserted };
  },
);

const enqueueWebhookDispatchMock = jest.fn();
const sendTipNotificationMock = jest.fn(async () => undefined);

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: { findUnique: findUniqueCreatorMock },
    tip: { createMany: createManyTipMock },
    indexerCursor: {
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  cacheInvalidate: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../modules/webhooks/webhooks.service.js", () => ({
  enqueueWebhookDispatch: enqueueWebhookDispatchMock,
}));

jest.unstable_mockModule(
  "../../modules/notifications/email.service.js",
  () => ({
    sendTipNotification: sendTipNotificationMock,
  }),
);

const { handleEvent } = await import("../../indexer/indexer.js");

describe("handleEvent dispatch gating (#278)", () => {
  const sampleEvent: TipEvent = {
    txHash: "0xnewtip123",
    ledger: 200,
    timestamp: "2023-11-14T22:13:20.000Z",
    jarId: "@alice",
    from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount: BigInt(5_000_000),
    message: "nice!",
  };

  beforeEach(() => {
    tipStore.clear();
    jest.clearAllMocks();
  });

  it("dispatches webhooks and email exactly once for a new tip and not at all on replay", async () => {
    await handleEvent(sampleEvent);

    expect(enqueueWebhookDispatchMock).toHaveBeenCalledTimes(1);
    expect(enqueueWebhookDispatchMock).toHaveBeenCalledWith(sampleEvent);
    expect(sendTipNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendTipNotificationMock).toHaveBeenCalledWith(sampleEvent);

    // Replay of the same txHash
    await handleEvent(sampleEvent);

    expect(enqueueWebhookDispatchMock).toHaveBeenCalledTimes(1);
    expect(sendTipNotificationMock).toHaveBeenCalledTimes(1);
    expect(tipStore.size).toBe(1);
  });
});
