/**
 * __tests__/indexer/indexer-backoff.test.ts
 *
 * Verifies that runLoop derives calculatePollBackoff's baseMs from the
 * configured/injected pollIntervalMs (#284).
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const actualBackoff = await import("../../indexer/backoff.js");
const calculatePollBackoffSpy = jest.fn(
  (consecutiveFailures: number, baseMs?: number, maxMs?: number) =>
    actualBackoff.calculatePollBackoff(consecutiveFailures, baseMs, maxMs),
);

const fetchTipEventsMock = jest.fn<() => Promise<never[]>>();

jest.unstable_mockModule("../../indexer/backoff.js", () => ({
  ...actualBackoff,
  calculatePollBackoff: calculatePollBackoffSpy,
}));

jest.unstable_mockModule("@novatip/sdk", () => ({
  fetchTipEvents: fetchTipEventsMock,
  getNetwork: jest.fn(() => ({ name: "testnet" })),
  networkFromEnv: jest.fn(() => ({ name: "testnet" })),
}));

jest.unstable_mockModule("../../indexer/rpc.js", () => ({
  fetchLatestLedger: jest.fn(async () => 100),
}));

jest.unstable_mockModule("../../indexer/persist.js", () => ({
  readCursor: jest.fn(async () => 100),
  updateCursor: jest.fn(async () => undefined),
  persistTip: jest.fn(async () => true),
}));

jest.unstable_mockModule("../../modules/webhooks/webhooks.service.js", () => ({
  enqueueWebhookDispatch: jest.fn(),
}));

jest.unstable_mockModule(
  "../../modules/notifications/email.service.js",
  () => ({
    sendTipNotification: jest.fn(async () => undefined),
  }),
);

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

describe("indexer poll backoff scaling (#284)", () => {
  beforeEach(async () => {
    await stopIndexer();
    calculatePollBackoffSpy.mockClear();
    fetchTipEventsMock.mockReset();
  });

  afterEach(async () => {
    await stopIndexer();
  });

  it("scales first-failure backoff proportionally with the injected pollIntervalMs", async () => {
    fetchTipEventsMock.mockRejectedValue(new Error("rpc unavailable"));

    const loop1 = startIndexer({ pollIntervalMs: 1_500, pollLimit: 200 });
    await new Promise((r) => setTimeout(r, 50));
    await stopIndexer();
    await loop1;

    expect(calculatePollBackoffSpy).toHaveBeenCalledWith(1, 3_000);
    expect(calculatePollBackoffSpy.mock.results[0]?.value).toBe(3_000);

    calculatePollBackoffSpy.mockClear();

    const loop2 = startIndexer({ pollIntervalMs: 500, pollLimit: 200 });
    await new Promise((r) => setTimeout(r, 50));
    await stopIndexer();
    await loop2;

    expect(calculatePollBackoffSpy).toHaveBeenCalledWith(1, 1_000);
    expect(calculatePollBackoffSpy.mock.results[0]?.value).toBe(1_000);
  });
});
