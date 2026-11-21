import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const DATABASE_URL = process.env["DATABASE_URL"];

// Skip these tests when no database is configured
const describeIf = DATABASE_URL ? describe : describe.skip;

jest.unstable_mockModule("../../redis.js", () => ({
  redis: {},
  cacheGet: async (): Promise<null> => null,
  cacheSet: async (): Promise<void> => undefined,
  cacheInvalidate: async (): Promise<void> => undefined,
}));

describeIf("Analytics Postgres Integration", () => {
  let db: (typeof import("../../db.js"))["db"];
  let disconnectDb: (typeof import("../../db.js"))["disconnectDb"];
  let getTotals: (typeof import("../../modules/analytics/analytics.service.js"))["getTotals"];
  let getTimeSeries: (typeof import("../../modules/analytics/analytics.service.js"))["getTimeSeries"];
  let getTopSupporters: (typeof import("../../modules/analytics/analytics.service.js"))["getTopSupporters"];
  let getCollaboratorEarnings: (typeof import("../../modules/analytics/analytics.service.js"))["getCollaboratorEarnings"];

  let creatorId: string;
  let creatorWallet: string;

  beforeAll(async () => {
    ({ db, disconnectDb } = await import("../../db.js"));
    ({
      getTotals,
      getTimeSeries,
      getTopSupporters,
      getCollaboratorEarnings,
    } = await import("../../modules/analytics/analytics.service.js"));

    await db.$connect();

    creatorWallet = "GTEST" + "A".repeat(51);
    const suffix = Date.now();
    const creator = await db.creator.create({
      data: {
        walletAddress: creatorWallet,
        slug: `test-analytics-${suffix}`,
        jarId: `@test-analytics-${suffix}`,
      },
    });
    creatorId = creator.id;
  });

  beforeEach(async () => {
    await db.tip.deleteMany({ where: { creatorId } });
    await db.creator.update({
      where: { id: creatorId },
      data: { splits: [] },
    });
  });

  afterAll(async () => {
    if (db && creatorId) {
      await db.tip.deleteMany({ where: { creatorId } });
      await db.creator.delete({ where: { id: creatorId } });
    }
    if (disconnectDb) {
      await disconnectDb();
    }
  });

  describe("getTotals", () => {
    it("calculates totals and unique supporters via getTotals()", async () => {
      const now = Date.now();
      await db.tip.createMany({
        data: [
          {
            creatorId,
            txHash: `hash1-${now}`,
            ledger: 1000,
            fromAddress: "GSENDER" + "A".repeat(49),
            amount: "1000000", // 1 USDC
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: `hash2-${now}`,
            ledger: 1001,
            fromAddress: "GSENDER" + "B".repeat(49),
            amount: "2500000", // 2.5 USDC
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: `hash3-${now}`,
            ledger: 1002,
            fromAddress: "GSENDER" + "A".repeat(49), // Same supporter
            amount: "500000", // 0.5 USDC
            ledgerAt: new Date(),
          },
        ],
      });

      const totals = await getTotals(creatorId);

      expect(totals).toEqual({
        totalTips: 3,
        totalAmountRaw: "4000000",
        uniqueSupporters: 2,
      });
    });

    it("handles large i128 amounts via getTotals()", async () => {
      // Max i128 is 170141183460469231731687303715884105727
      const largeAmount = "170141183460469231731687303715884105727";

      await db.tip.create({
        data: {
          creatorId,
          txHash: `hash-large-${Date.now()}`,
          ledger: 2000,
          fromAddress: "GBIG" + "A".repeat(52),
          amount: largeAmount,
          ledgerAt: new Date(),
        },
      });

      const totals = await getTotals(creatorId);

      expect(totals).toEqual({
        totalTips: 1,
        totalAmountRaw: largeAmount,
        uniqueSupporters: 1,
      });
    });
  });

  describe("getTimeSeries", () => {
    it("aggregates tips by UTC day and fills zero-tip days with { tipCount: 0, amountRaw: '0' }", async () => {
      const now = new Date();
      const todayUtc = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0),
      );
      const yesterdayUtc = new Date(todayUtc.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgoUtc = new Date(
        todayUtc.getTime() - 2 * 24 * 60 * 60 * 1000,
      );

      const suffix = Date.now();
      await db.tip.createMany({
        data: [
          {
            creatorId,
            txHash: `ts1-${suffix}`,
            ledger: 3000,
            fromAddress: "GADDR" + "A".repeat(51),
            amount: "1000000",
            ledgerAt: twoDaysAgoUtc,
          },
          // Intentionally no tips on yesterdayUtc to exercise gap-filling
          {
            creatorId,
            txHash: `ts3-${suffix}`,
            ledger: 3002,
            fromAddress: "GADDR" + "C".repeat(51),
            amount: "3000000",
            ledgerAt: todayUtc,
          },
        ],
      });

      const series = await getTimeSeries(creatorId, 3);

      expect(series).toEqual([
        {
          date: twoDaysAgoUtc.toISOString().slice(0, 10),
          tipCount: 1,
          amountRaw: "1000000",
        },
        {
          date: yesterdayUtc.toISOString().slice(0, 10),
          tipCount: 0,
          amountRaw: "0",
        },
        {
          date: todayUtc.toISOString().slice(0, 10),
          tipCount: 1,
          amountRaw: "3000000",
        },
      ]);
    });
  });

  describe("getTopSupporters", () => {
    it("ranks supporters by total amount via getTopSupporters()", async () => {
      const supporter1 = "GTOP1" + "A".repeat(51);
      const supporter2 = "GTOP2" + "B".repeat(51);
      const supporter3 = "GTOP3" + "C".repeat(51);
      const suffix = Date.now();

      await db.tip.createMany({
        data: [
          {
            creatorId,
            txHash: `top1-${suffix}-1`,
            ledger: 4000,
            fromAddress: supporter1,
            amount: "5000000",
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: `top1-${suffix}-2`,
            ledger: 4001,
            fromAddress: supporter1,
            amount: "3000000",
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: `top2-${suffix}`,
            ledger: 4002,
            fromAddress: supporter2,
            amount: "6000000",
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: `top3-${suffix}`,
            ledger: 4003,
            fromAddress: supporter3,
            amount: "1000000",
            ledgerAt: new Date(),
          },
        ],
      });

      const supporters = await getTopSupporters(creatorId, 3);

      expect(supporters).toEqual([
        { fromAddress: supporter1, tipCount: 2, totalAmountRaw: "8000000" },
        { fromAddress: supporter2, tipCount: 1, totalAmountRaw: "6000000" },
        { fromAddress: supporter3, tipCount: 1, totalAmountRaw: "1000000" },
      ]);
    });
  });

  describe("getCollaboratorEarnings", () => {
    it("calculates per-recipient earnings via getCollaboratorEarnings()", async () => {
      const recipient1 = "GCOLLAB1" + "A".repeat(48);
      const recipient2 = "GCOLLAB2" + "B".repeat(48);
      const suffix = Date.now();

      // Set up splits: 50% to recipient1, 30% to recipient2
      await db.creator.update({
        where: { id: creatorId },
        data: {
          splits: [
            { to: recipient1, bps: 5000 },
            { to: recipient2, bps: 3000 },
          ],
        },
      });

      await db.tip.createMany({
        data: [
          {
            creatorId,
            txHash: `collab1-${suffix}`,
            ledger: 5000,
            fromAddress: "GSEND" + "A".repeat(51),
            amount: "10000000", // 10 USDC
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: `collab2-${suffix}`,
            ledger: 5001,
            fromAddress: "GSEND" + "B".repeat(51),
            amount: "5000000", // 5 USDC
            ledgerAt: new Date(),
          },
        ],
      });

      const breakdown = await getCollaboratorEarnings(creatorId);

      expect(breakdown.tipCount).toBe(2);
      expect(breakdown.totalAmountRaw).toBe("15000000");
      expect(breakdown.unallocatedRaw).toBe("3000000");
      expect(breakdown.collaborators).toEqual([
        {
          to: recipient1,
          bps: 5000,
          sharePercent: 50,
          totalEarnedRaw: "7500000",
        },
        {
          to: recipient2,
          bps: 3000,
          sharePercent: 30,
          totalEarnedRaw: "4500000",
        },
      ]);
      expect(breakdown.basis.mode).toBe("current-splits");
      expect(breakdown.basis.impliedOwnerSplit).toBe(false);
    });
  });
});
