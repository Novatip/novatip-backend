/**
 * __tests__/indexer/indexer.test.ts
 *
 * Integration tests for the indexer's real runLoop / handleEvent wiring (#283).
 * Drives non-empty TipEvent batches through startIndexer() and verifies
 * persistence, webhook dispatch, email notifications, cursor advancement,
 * idempotency (isNew), and mid-batch failure retry behaviour.
 */

import { jest } from "@jest/globals";
import type { TipEvent } from "@novatip/sdk";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const fetchTipEventsMock = jest.fn<(opts: { startLedger: number; limit: number }) => Promise<TipEvent[]>>();
const fetchLatestLedgerMock = jest.fn<() => Promise<number>>();
const readCursorMock = jest.fn<() => Promise<number>>();
const updateCursorMock = jest.fn<(ledger: number) => Promise<void>>();
const persistTipMock = jest.fn<(event: TipEvent, txHash: string) => Promise<boolean>>();
const enqueueWebhookDispatchMock = jest.fn<(event: TipEvent) => void>();
const sendTipNotificationMock = jest.fn<(event: TipEvent) => Promise<void>>();
const calculatePollBackoffMock = jest.fn<() => number>(() => 0);

jest.unstable_mockModule("@novatip/sdk", () => ({
  fetchTipEvents: fetchTipEventsMock,
  networkFromEnv: jest.fn(() => ({ name: "testnet" })),
}));

jest.unstable_mockModule("../../indexer/rpc.js", () => ({
  fetchLatestLedger: fetchLatestLedgerMock,
}));

jest.unstable_mockModule("../../indexer/persist.js", () => ({
  readCursor: readCursorMock,
  updateCursor: updateCursorMock,
  persistTip: persistTipMock,
}));

jest.unstable_mockModule("../../modules/webhooks/webhooks.service.js", () => ({
  enqueueWebhookDispatch: enqueueWebhookDispatchMock,
}));

jest.unstable_mockModule("../../modules/notifications/email.service.js", () => ({
  sendTipNotification: sendTipNotificationMock,
}));

jest.unstable_mockModule("../../indexer/backoff.js", () => ({
  calculatePollBackoff: calculatePollBackoffMock,
}));

jest.unstable_mockModule("../../db.js", () => ({
  db: {},
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  cacheInvalidate: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { startIndexer, stopIndexer } = await import(
  "../../indexer/indexer.js"
);

function makeEvent(overrides: Partial<TipEvent> & { txHash: string; ledger: number }): TipEvent {
  return {
    jarId: "@alice",
    from: "GUSER123",
    amount: 100n,
    message: "gm",
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("indexer runLoop / handleEvent wiring (#283)", () => {
  beforeEach(async () => {
    await stopIndexer();
    jest.clearAllMocks();
    readCursorMock.mockResolvedValue(100);
    fetchLatestLedgerMock.mockResolvedValue(105);
    updateCursorMock.mockResolvedValue(undefined);
    persistTipMock.mockResolvedValue(true);
    sendTipNotificationMock.mockResolvedValue(undefined);
    calculatePollBackoffMock.mockReturnValue(0);
  });

  afterEach(async () => {
    await stopIndexer();
  });

  it("persists each event, dispatches webhooks and email, and updates cursor with cursorLedger", async () => {
    const event1 = makeEvent({ txHash: "tx-1", ledger: 101 });
    const event2 = makeEvent({ txHash: "tx-2", ledger: 102, jarId: "@bob" });

    let callCount = 0;
    fetchTipEventsMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [event1, event2];
      }
      await stopIndexer();
      return [];
    });

    await startIndexer({ pollIntervalMs: 1, pollLimit: 200 });

    expect(persistTipMock).toHaveBeenCalledTimes(2);
    expect(persistTipMock).toHaveBeenNthCalledWith(1, event1, "tx-1");
    expect(persistTipMock).toHaveBeenNthCalledWith(2, event2, "tx-2");

    expect(enqueueWebhookDispatchMock).toHaveBeenCalledTimes(2);
    expect(enqueueWebhookDispatchMock).toHaveBeenNthCalledWith(1, event1);
    expect(enqueueWebhookDispatchMock).toHaveBeenNthCalledWith(2, event2);

    expect(sendTipNotificationMock).toHaveBeenCalledTimes(2);
    expect(sendTipNotificationMock).toHaveBeenNthCalledWith(1, event1);
    expect(sendTipNotificationMock).toHaveBeenNthCalledWith(2, event2);

    expect(updateCursorMock).toHaveBeenCalledTimes(1);
    expect(updateCursorMock).toHaveBeenCalledWith(102);

    expect(fetchTipEventsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ startLedger: 101 }),
    );
    expect(fetchTipEventsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startLedger: 103 }),
    );
  });

  it("does not trigger webhooks or email for an already-existing tip while triggering for a new one", async () => {
    const existingEvent = makeEvent({ txHash: "tx-existing", ledger: 101 });
    const newEvent = makeEvent({ txHash: "tx-new", ledger: 102 });

    persistTipMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    let callCount = 0;
    fetchTipEventsMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [existingEvent, newEvent];
      }
      await stopIndexer();
      return [];
    });

    await startIndexer({ pollIntervalMs: 1, pollLimit: 200 });

    expect(persistTipMock).toHaveBeenCalledTimes(2);
    expect(enqueueWebhookDispatchMock).toHaveBeenCalledTimes(1);
    expect(enqueueWebhookDispatchMock).toHaveBeenCalledWith(newEvent);

    expect(sendTipNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendTipNotificationMock).toHaveBeenCalledWith(newEvent);

    expect(updateCursorMock).toHaveBeenCalledWith(102);
  });

  it("does not advance startLedger or cursor when persistTip throws mid-batch and retries from the same startLedger", async () => {
    const event1 = makeEvent({ txHash: "tx-1", ledger: 101 });
    const event2 = makeEvent({ txHash: "tx-2", ledger: 102 });

    persistTipMock
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("transient db failure"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    let callCount = 0;
    fetchTipEventsMock.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return [event1, event2];
      }
      await stopIndexer();
      return [];
    });

    await startIndexer({ pollIntervalMs: 1, pollLimit: 200 });

    // Both the failed iteration and the retry iteration must start from ledger 101.
    expect(fetchTipEventsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ startLedger: 101 }),
    );
    expect(fetchTipEventsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startLedger: 101 }),
    );
    // Once the retry succeeds, the third iteration advances to 103.
    expect(fetchTipEventsMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ startLedger: 103 }),
    );

    // Cursor is only updated once, after the retry batch succeeds.
    expect(updateCursorMock).toHaveBeenCalledTimes(1);
    expect(updateCursorMock).toHaveBeenCalledWith(102);
  });
});
