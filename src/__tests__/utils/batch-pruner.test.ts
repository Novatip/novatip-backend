import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
  createBatchPruner,
  cutoffFor,
  MS_PER_DAY,
  MAX_BATCHES_PER_RUN,
  FIRST_RUN_DELAY_MS,
  type BatchPrunerLogger,
} from "../../utils/batch-pruner.js";

describe("batch-pruner constants and cutoff", () => {
  it("defines expected default constants", () => {
    expect(MS_PER_DAY).toBe(86_400_000);
    expect(MAX_BATCHES_PER_RUN).toBe(50);
    expect(FIRST_RUN_DELAY_MS).toBe(60_000);
  });

  it("calculates the cutoff date correctly", () => {
    const now = new Date("2026-06-01T12:00:00.000Z");
    const cutoff = cutoffFor(10, now);
    expect(cutoff.toISOString()).toBe("2026-05-22T12:00:00.000Z");
  });
});

describe("createBatchPruner scheduler loop", () => {
  let mockLogger: {
    info: jest.MockedFunction<BatchPrunerLogger["info"]>;
    error: jest.MockedFunction<BatchPrunerLogger["error"]>;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("does not start and logs disabledMessage when retention is not enabled", () => {
    const pruneFn = jest.fn(async () => ({ deleted: 0, truncated: false }));

    const pruner = createBatchPruner({
      logger: mockLogger,
      name: "test",
      retentionEnabled: () => false,
      disabledMessage: "retention disabled",
      getIntervalMs: () => 60_000,
      runPrune: pruneFn,
    });

    pruner.start();

    expect(mockLogger.info).toHaveBeenCalledWith("retention disabled");
    expect(pruneFn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(120_000);
    expect(pruneFn).not.toHaveBeenCalled();
  });

  it("starts, schedules first run, runs prune, and logs success", async () => {
    const pruneFn = jest.fn(async () => ({ deleted: 5, truncated: false }));

    const pruner = createBatchPruner({
      logger: mockLogger,
      name: "test entity",
      description: "test entities",
      retentionEnabled: () => true,
      disabledMessage: "retention disabled",
      getStartMetadata: () => ({ interval: 60 }),
      firstRunDelayMs: 1_000,
      getIntervalMs: () => 60_000,
      runPrune: pruneFn,
      getTotalDeleted: (r) => r.deleted,
    });

    pruner.start();

    expect(mockLogger.info).toHaveBeenCalledWith(
      { interval: 60 },
      "starting test entity pruner",
    );

    // Fast-forward to the first run
    await jest.advanceTimersByTimeAsync(1_000);

    expect(pruneFn).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { deleted: 5, truncated: false },
      "pruned test entities",
    );

    // Fast-forward to the next interval
    await jest.advanceTimersByTimeAsync(60_000);
    expect(pruneFn).toHaveBeenCalledTimes(2);

    pruner.stop();
  });

  it("logs truncated notice when batch ceiling was reached", async () => {
    const pruneFn = jest.fn(async () => ({ deleted: 50, truncated: true }));

    const pruner = createBatchPruner({
      logger: mockLogger,
      name: "test entity",
      description: "test entities",
      retentionEnabled: () => true,
      disabledMessage: "retention disabled",
      firstRunDelayMs: 500,
      getIntervalMs: () => 60_000,
      runPrune: pruneFn,
    });

    pruner.start();
    await jest.advanceTimersByTimeAsync(500);

    expect(mockLogger.info).toHaveBeenCalledWith(
      { deleted: 50, truncated: true },
      "pruned test entities — batch ceiling reached, continuing next run",
    );

    pruner.stop();
  });

  it("swallows error and logs it without crashing when prune rejects", async () => {
    const pruneError = new Error("db failure");
    const pruneFn = jest.fn(async () => {
      throw pruneError;
    });

    const pruner = createBatchPruner({
      logger: mockLogger,
      name: "test entity",
      retentionEnabled: () => true,
      disabledMessage: "retention disabled",
      firstRunDelayMs: 500,
      getIntervalMs: () => 60_000,
      runPrune: pruneFn,
    });

    pruner.start();
    await jest.advanceTimersByTimeAsync(500);

    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: pruneError },
      "test entity prune failed",
    );

    // Ensure it still rescheduled despite the error
    await jest.advanceTimersByTimeAsync(60_000);
    expect(pruneFn).toHaveBeenCalledTimes(2);

    pruner.stop();
  });

  it("stops future execution when stop() is called", async () => {
    const pruneFn = jest.fn(async () => ({ deleted: 0, truncated: false }));

    const pruner = createBatchPruner({
      logger: mockLogger,
      name: "test entity",
      retentionEnabled: () => true,
      disabledMessage: "retention disabled",
      firstRunDelayMs: 1_000,
      getIntervalMs: () => 60_000,
      runPrune: pruneFn,
    });

    pruner.start();
    pruner.stop();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(pruneFn).not.toHaveBeenCalled();
  });
});
