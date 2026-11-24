/**
 * __tests__/indexer/persist.test.ts
 *
 * Covers:
 * - Unclaimed jar tip persistence with creatorId: null and info log line (#151)
 * - Named constant INDEXER_CURSOR_ID for single-row cursor table (#84)
 */

import { jest } from "@jest/globals";
import type { TipEvent } from "@novatip/sdk";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const findUniqueCreatorMock =
  jest.fn<
    (args: { where: { jarId: string } }) => Promise<{ id: string } | null>
  >();
const createManyTipMock =
  jest.fn<
    (args: Record<string, unknown>) => Promise<{ count: number }>
  >();
const findManyTipMock =
  jest.fn<
    (args: Record<string, unknown>) => Promise<Array<{ id: string }>>
  >();
const deleteManyTipMock =
  jest.fn<
    (args: Record<string, unknown>) => Promise<{ count: number }>
  >();
const upsertCursorMock =
  jest.fn<
    (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  >();
const findUniqueCursorMock =
  jest.fn<
    (args: {
      where: { id: number };
    }) => Promise<{ id: number; lastLedger: number } | null>
  >();

const loggerInfoMock = jest.fn();

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: { findUnique: findUniqueCreatorMock },
    tip: {
      createMany: createManyTipMock,
      findMany: findManyTipMock,
      deleteMany: deleteManyTipMock,
    },
    indexerCursor: {
      upsert: upsertCursorMock,
      findUnique: findUniqueCursorMock,
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../utils/logger.js", () => ({
  logger: {
    child: (): Record<string, unknown> => ({
      info: loggerInfoMock,
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}));

const {
  persistTip,
  updateCursor,
  readCursor,
  pruneUnownedTips,
  startUnownedTipPruner,
  stopUnownedTipPruner,
  INDEXER_CURSOR_ID,
} = await import("../../indexer/persist.js");

describe("indexer persist (#151 unclaimed jar persistence & #84 named cursor id)", () => {
  const sampleEvent: TipEvent = {
    txHash: "0xdeadbeef",
    ledger: 100,
    timestamp: "2023-11-14T22:13:20.000Z",
    jarId: "@unknown_jar",
    from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount: BigInt(5000000),
    message: "great work!",
  };

  beforeEach(() => {
    stopUnownedTipPruner();
    jest.clearAllMocks();
    createManyTipMock.mockResolvedValue({ count: 1 });
    findManyTipMock.mockResolvedValue([]);
    deleteManyTipMock.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    stopUnownedTipPruner();
  });

  it("exports named constant INDEXER_CURSOR_ID as 1 (#84)", () => {
    expect(INDEXER_CURSOR_ID).toBe(1);
  });

  it("uses INDEXER_CURSOR_ID in updateCursor (#84)", async () => {
    await updateCursor(500);

    expect(upsertCursorMock).toHaveBeenCalledWith({
      where: { id: INDEXER_CURSOR_ID },
      update: { lastLedger: 500 },
      create: { id: INDEXER_CURSOR_ID, lastLedger: 500 },
    });
  });

  it("uses INDEXER_CURSOR_ID in readCursor (#84)", async () => {
    findUniqueCursorMock.mockResolvedValue({
      id: INDEXER_CURSOR_ID,
      lastLedger: 450,
    });

    const ledger = await readCursor();

    expect(ledger).toBe(450);
    expect(findUniqueCursorMock).toHaveBeenCalledWith({
      where: { id: INDEXER_CURSOR_ID },
    });
  });

  it("logs at info level and stores tip with creatorId: null when jarId is unclaimed (#151)", async () => {
    findUniqueCreatorMock.mockResolvedValue(null);

    const isNew = await persistTip(sampleEvent, "0xdeadbeef");

    expect(isNew).toBe(true);
    expect(findUniqueCreatorMock).toHaveBeenCalledWith({
      where: { jarId: sampleEvent.jarId },
    });
    expect(createManyTipMock).toHaveBeenCalledWith({
      data: [
        {
          txHash: "0xdeadbeef",
          ledger: sampleEvent.ledger,
          ledgerAt: new Date(sampleEvent.timestamp),
          fromAddress: sampleEvent.from,
          amount: sampleEvent.amount.toString(),
          message: sampleEvent.message,
          jarId: sampleEvent.jarId,
          creatorId: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      { jarId: sampleEvent.jarId },
      expect.stringMatching(/unclaimed jar.*stored without owner/),
    );
  });

  it("writes a tip row when jarId belongs to a known creator (#86)", async () => {
    findUniqueCreatorMock.mockResolvedValue({ id: "creator_valid" });

    const isNew = await persistTip(sampleEvent, "0xfeedbeef");

    expect(isNew).toBe(true);
    expect(findUniqueCreatorMock).toHaveBeenCalledWith({
      where: { jarId: sampleEvent.jarId },
    });
    expect(loggerInfoMock).not.toHaveBeenCalled();
    expect(createManyTipMock).toHaveBeenCalledWith({
      data: [
        {
          txHash: "0xfeedbeef",
          ledger: sampleEvent.ledger,
          ledgerAt: new Date(sampleEvent.timestamp),
          fromAddress: sampleEvent.from,
          amount: sampleEvent.amount.toString(),
          message: sampleEvent.message,
          jarId: sampleEvent.jarId,
          creatorId: "creator_valid",
        },
      ],
      skipDuplicates: true,
    });
  });

  it("persists a tip row with creatorId: null and jarId set when jarId is unknown (#151)", async () => {
    findUniqueCreatorMock.mockResolvedValue(null);

    await persistTip(sampleEvent, "0xunknownjar");

    expect(findUniqueCreatorMock).toHaveBeenCalledWith({
      where: { jarId: sampleEvent.jarId },
    });
    expect(createManyTipMock).toHaveBeenCalledWith({
      data: [
        {
          txHash: "0xunknownjar",
          ledger: sampleEvent.ledger,
          ledgerAt: new Date(sampleEvent.timestamp),
          fromAddress: sampleEvent.from,
          amount: sampleEvent.amount.toString(),
          message: sampleEvent.message,
          jarId: sampleEvent.jarId,
          creatorId: null,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("is idempotent and returns true on creation, false on replay for owned and unowned jars (#86, #278)", async () => {
    const tipStore = new Map<string, Record<string, unknown>>();
    createManyTipMock.mockImplementation(async (args: Record<string, unknown>) => {
      const data = args["data"] as Array<Record<string, unknown>>;
      let count = 0;
      for (const row of data) {
        const txHash = row["txHash"] as string;
        if (!tipStore.has(txHash)) {
          tipStore.set(txHash, { id: `tip_${tipStore.size + 1}`, ...row });
          count += 1;
        }
      }
      return { count };
    });

    // Owned jar path
    findUniqueCreatorMock.mockResolvedValue({ id: "creator_valid" });
    expect(await persistTip(sampleEvent, "0xreplayed_owned")).toBe(true);
    expect(tipStore.size).toBe(1);
    expect(await persistTip(sampleEvent, "0xreplayed_owned")).toBe(false);
    expect(tipStore.size).toBe(1);

    // Unowned jar path
    findUniqueCreatorMock.mockResolvedValue(null);
    expect(await persistTip(sampleEvent, "0xreplayed_unowned")).toBe(true);
    expect(tipStore.size).toBe(2);
    expect(await persistTip(sampleEvent, "0xreplayed_unowned")).toBe(false);
    expect(tipStore.size).toBe(2);
  });

  it("prunes unowned tips in bounded batches (#280)", async () => {
    findManyTipMock
      .mockResolvedValueOnce([{ id: "t1" }, { id: "t2" }])
      .mockResolvedValueOnce([{ id: "t3" }]);
    deleteManyTipMock
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    const deleted = await pruneUnownedTips(90, 2, 10);

    expect(deleted).toBe(3);
    expect(findManyTipMock).toHaveBeenCalledTimes(2);
    expect(findManyTipMock).toHaveBeenNthCalledWith(1, {
      where: {
        creatorId: null,
        ledgerAt: { lt: expect.any(Date) },
      },
      select: { id: true },
      take: 2,
    });
    expect(deleteManyTipMock).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ["t1", "t2"] } },
    });
    expect(deleteManyTipMock).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ["t3"] } },
    });
  });

  it("deletes unowned tips older than the configured window when the scheduler runs (#280)", async () => {
    const now = Date.now();
    const tips = [
      {
        id: "old_unowned",
        creatorId: null,
        ledgerAt: new Date(now - 91 * 86_400_000),
      },
      {
        id: "fresh_unowned",
        creatorId: null,
        ledgerAt: new Date(now - 10 * 86_400_000),
      },
      {
        id: "old_owned",
        creatorId: "creator_1",
        ledgerAt: new Date(now - 120 * 86_400_000),
      },
    ];

    findManyTipMock.mockImplementation(async (args: Record<string, unknown>) => {
      const where = args["where"] as {
        creatorId: null;
        ledgerAt: { lt: Date };
      };
      return tips
        .filter(
          (t) =>
            t.creatorId === where.creatorId &&
            t.ledgerAt.getTime() < where.ledgerAt.lt.getTime(),
        )
        .map((t) => ({ id: t.id }));
    });
    deleteManyTipMock.mockImplementation(async (args: Record<string, unknown>) => {
      const where = args["where"] as { id: { in: string[] } };
      const ids = new Set(where.id.in);
      let count = 0;
      for (let i = tips.length - 1; i >= 0; i -= 1) {
        if (ids.has(tips[i]!.id)) {
          tips.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    });

    startUnownedTipPruner({ firstRunDelayMs: 20, intervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 60));
    stopUnownedTipPruner();

    expect(tips.map((t) => t.id)).toEqual(["fresh_unowned", "old_owned"]);
  });
});
