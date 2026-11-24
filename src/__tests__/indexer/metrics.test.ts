/**
 * __tests__/indexer/metrics.test.ts
 *
 * Regression tests for indexer Prometheus metrics wiring (#313):
 * - A poll iteration with events completes without triggering error backoff or error logs
 * - novatip_tips_indexed_total increments only for newly-persisted tips
 * - novatip_indexer_cursor_ledger and novatip_indexer_lag_ledgers are updated
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const fetchTipEventsMock = jest.fn<() => Promise<any[]>>();
const fetchLatestLedgerMock = jest.fn(async () => 150);
const readCursorMock = jest.fn(async () => 100);
const updateCursorMock = jest.fn(async (_ledger: number) => {});
const persistTipMock = jest.fn(async (_event: any, _txHash: string) => true);
const calculatePollBackoffMock = jest.fn((_failures: number) => 12_000);
const errorLogMock = jest.fn();

jest.unstable_mockModule("@novatip/sdk", () => ({
  fetchTipEvents: fetchTipEventsMock,
  getNetwork: jest.fn(() => ({ name: "testnet" })),
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

jest.unstable_mockModule("../../indexer/backoff.js", () => ({
  calculatePollBackoff: calculatePollBackoffMock,
}));

jest.unstable_mockModule("../../utils/logger.js", () => {
  const childLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: errorLogMock,
    debug: jest.fn(),
  };
  return {
    logger: {
      child: jest.fn(() => childLogger),
      info: jest.fn(),
      warn: jest.fn(),
      error: errorLogMock,
      debug: jest.fn(),
    },
    buildLoggerOptions: jest.fn(() => ({})),
  };
});

jest.unstable_mockModule("../../modules/webhooks/webhooks.service.js", () => ({
  enqueueWebhookDispatch: jest.fn(),
}));

jest.unstable_mockModule("../../modules/notifications/email.service.js", () => ({
  sendTipNotification: jest.fn(async () => {}),
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

const { startIndexer, stopIndexer } = await import("../../indexer/indexer.js");
const { getIndexerPollStatus } = await import("../../indexer/status.js");
const {
  tipsIndexedCounter,
  indexerCursorGauge,
  indexerLagGauge,
} = await import("../../modules/metrics/metrics.service.js");

function makeTipEvent(ledger: number, txHash: string) {
  return {
    ledger,
    txHash,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: "1000000",
    asset: "USDC",
    message: "thanks",
  };
}

describe("indexer metrics wiring (#313)", () => {
  beforeEach(async () => {
    await stopIndexer();
    fetchTipEventsMock.mockReset();
    fetchLatestLedgerMock.mockReset();
    fetchLatestLedgerMock.mockResolvedValue(150);
    readCursorMock.mockReset();
    readCursorMock.mockResolvedValue(100);
    updateCursorMock.mockReset();
    persistTipMock.mockReset();
    persistTipMock.mockResolvedValue(true);
    calculatePollBackoffMock.mockClear();
    errorLogMock.mockClear();
    tipsIndexedCounter.reset();
  });

  afterEach(async () => {
    await stopIndexer();
  });

  test("poll with events succeeds without incrementing backoff or logging an error", async () => {
    fetchTipEventsMock.mockResolvedValueOnce([
      makeTipEvent(110, "tx-hash-1"),
    ]);
    fetchTipEventsMock.mockResolvedValue([]);

    const loopPromise = startIndexer({ pollIntervalMs: 10_000, pollLimit: 200 });

    await new Promise((r) => setTimeout(r, 50));
    await stopIndexer();
    await loopPromise;

    expect(updateCursorMock).toHaveBeenCalledWith(110);
    expect(calculatePollBackoffMock).not.toHaveBeenCalled();
    expect(errorLogMock).not.toHaveBeenCalled();
    expect(getIndexerPollStatus().lastError).toBeNull();
    expect(getIndexerPollStatus().lastSuccessfulPollAt).not.toBeNull();

    const cursorMetric = await indexerCursorGauge.get();
    expect(cursorMetric.values[0]?.value).toBe(110);

    const lagMetric = await indexerLagGauge.get();
    expect(lagMetric.values[0]?.value).toBe(49);
  });

  test("novatip_tips_indexed_total increments only when a new tip is handled", async () => {
    fetchTipEventsMock.mockResolvedValueOnce([
      makeTipEvent(112, "tx-hash-new"),
      makeTipEvent(112, "tx-hash-dup"),
    ]);
    fetchTipEventsMock.mockResolvedValue([]);
    persistTipMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const loopPromise = startIndexer({ pollIntervalMs: 10_000, pollLimit: 200 });

    await new Promise((r) => setTimeout(r, 50));
    await stopIndexer();
    await loopPromise;

    const metric = await tipsIndexedCounter.get();
    expect(metric.values[0]?.value).toBe(1);
  });
});
