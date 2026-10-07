/**
 * __tests__/analytics/collaborators.test.ts
 *
 * Covers the per-collaborator earnings breakdown.
 *
 * The gap it closes: a jar splits every tip across collaborators, but
 * analytics only reported totals for the jar as a whole, so a creator in a
 * three-way band could not answer "how much has each of us earned".
 *
 * db and redis are mocked so this runs without PostgreSQL or Redis. The
 * $queryRaw fake computes the aggregate from an in-memory list of tips, so
 * what is under test is the service's assembly of the result — the stroop
 * arithmetic, the remainder, the implied owner split, the basis it reports —
 * rather than Postgres' `floor`. That the truncation happens per tip inside
 * the query, and not against the jar total, is asserted separately by
 * inspecting the SQL the service builds.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@prisma/client";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR_ID = "creator_1";
const OWNER = "GOWNER0000000000000000000000000000000000000000000000000";
const ALICE = "GALICE0000000000000000000000000000000000000000000000000";
const BOB = "GBOB000000000000000000000000000000000000000000000000000";
const CAROL = "GCAROL0000000000000000000000000000000000000000000000000";

const SPLITS_UPDATED_AT = new Date("2026-05-06T07:08:09.010Z");

/** The creator row the service reads. `splits` is a Json column. */
let creatorRow: {
  walletAddress: string;
  splits: unknown;
  updatedAt: Date;
} | null = null;

/** Tip amounts in stroops, as the Tip table would hold them. */
let tips: bigint[] = [];

/** The last SQL the service built, for the per-tip-truncation assertion. */
let lastQuery: Prisma.Sql | null = null;

function sumPerTipShare(bps: bigint): bigint {
  // The query's floor(amount * bps / 10000), summed per tip.
  return tips.reduce((acc, amount) => acc + (amount * bps) / 10_000n, 0n);
}

const findUnique = jest.fn(async () => creatorRow);

const queryRaw = jest.fn(async (query: Prisma.Sql) => {
  lastQuery = query;

  // The bps parameters, in the order the share columns were built.
  const bpsValues = query.values.filter(
    (value): value is number => typeof value === "number",
  );

  const row: Record<string, unknown> = {
    tipCount: BigInt(tips.length),
    totalAmountRaw: tips.reduce((a, b) => a + b, 0n).toString(),
  };
  bpsValues.forEach((bps, i) => {
    row[`s${i}`] = sumPerTipShare(BigInt(bps)).toString();
  });

  return [row];
});

jest.unstable_mockModule("../../db.js", () => ({
  db: { creator: { findUnique }, $queryRaw: queryRaw },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: async (): Promise<null> => null,
  cacheSet: async (): Promise<void> => undefined,
  cacheInvalidate: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: async (): Promise<never> => {
    throw new Error("not used by this suite");
  },
}));

const { bpsToPercent, parseSplits, parseStroops, unallocated } =
  await import("../../modules/analytics/collaborators.js");
const { getCollaboratorEarnings } =
  await import("../../modules/analytics/analytics.service.js");

beforeEach(() => {
  creatorRow = {
    walletAddress: OWNER,
    splits: [
      { to: ALICE, bps: 5_000 },
      { to: BOB, bps: 3_000 },
      { to: CAROL, bps: 2_000 },
    ],
    updatedAt: SPLITS_UPDATED_AT,
  };
  tips = [];
  lastQuery = null;
  findUnique.mockClear();
  queryRaw.mockClear();
});

// ── Stored splits ─────────────────────────────────────────────────────────────

describe("parseSplits", () => {
  it("accepts the shape PATCH /creators/me/splits writes", () => {
    expect(parseSplits([{ to: ALICE, bps: 5_000 }])).toEqual([
      { to: ALICE, bps: 5_000 },
    ]);
  });

  it("accepts an empty array", () => {
    expect(parseSplits([])).toEqual([]);
  });

  describe("fails loudly on a malformed entry", () => {
    // A skipped recipient would read as "you earned nothing", which is worse
    // than an error — this endpoint reports money.
    const bad: Array<[string, unknown]> = [
      ["a non-array", { to: ALICE, bps: 1 }],
      ["null", null],
      ["a non-object entry", ["nope"]],
      ["a missing address", [{ bps: 5_000 }]],
      ["an empty address", [{ to: "   ", bps: 5_000 }]],
      ["a fractional bps", [{ to: ALICE, bps: 12.5 }]],
      ["a string bps", [{ to: ALICE, bps: "5000" }]],
      ["a negative bps", [{ to: ALICE, bps: -1 }]],
      ["a bps over 10000", [{ to: ALICE, bps: 10_001 }]],
    ];

    test.each(bad)("rejects %s", (_label, value) => {
      expect(() => parseSplits(value)).toThrow(/Stored splits are malformed/);
    });

    it("reports a data fault as a 500, not a bad request", () => {
      // The caller sent nothing wrong; the stored column is at fault.
      expect(() => parseSplits("nope")).toThrow(
        expect.objectContaining({ statusCode: 500 }) as Error,
      );
    });

    it("names the offending index so it can be found", () => {
      expect(() =>
        parseSplits([
          { to: ALICE, bps: 5_000 },
          { to: BOB, bps: 1.5 },
        ]),
      ).toThrow(/splits\[1\]\.bps/);
    });
  });
});

// ── Share formatting ──────────────────────────────────────────────────────────

describe("bpsToPercent", () => {
  test.each([
    [10_000, "100.00"],
    [5_000, "50.00"],
    [3_333, "33.33"],
    [1, "0.01"],
    [10, "0.10"],
    [0, "0.00"],
  ])("renders %i bps as %s", (bps, expected) => {
    expect(bpsToPercent(bps)).toBe(expected);
  });
});

// ── Stroop parsing ────────────────────────────────────────────────────────────

describe("parseStroops", () => {
  it("reads a sum well past what a double holds exactly", () => {
    // 2^53 + 1: the first integer a JS number cannot represent.
    expect(parseStroops("9007199254740993")).toBe(9_007_199_254_740_993n);
  });

  it("treats an empty aggregate as zero", () => {
    expect(parseStroops(null)).toBe(0n);
    expect(parseStroops("")).toBe(0n);
  });

  it("rejects a fractional amount rather than truncating it", () => {
    // Stroops are indivisible; a fraction means the query changed shape.
    expect(() => parseStroops("1.5")).toThrow(/whole stroop amount/);
  });
});

describe("unallocated", () => {
  it("is the balance when splits do not sum to 10000 bps", () => {
    expect(unallocated(1_000n, [500n, 300n])).toBe(200n);
  });

  it("is zero when the shares account for everything", () => {
    expect(unallocated(1_000n, [500n, 500n])).toBe(0n);
  });
});

// ── The breakdown ─────────────────────────────────────────────────────────────

describe("getCollaboratorEarnings", () => {
  it("returns every recipient with their share and total earned", async () => {
    tips = [10_000_000n, 20_000_000n]; // 1 and 2 USDC

    const result = await getCollaboratorEarnings(CREATOR_ID);

    expect(result.tipCount).toBe(2);
    expect(result.totalAmountRaw).toBe("30000000");
    expect(result.collaborators).toEqual([
      {
        to: ALICE,
        bps: 5_000,
        sharePercent: "50.00",
        totalEarnedRaw: "15000000",
      },
      {
        to: BOB,
        bps: 3_000,
        sharePercent: "30.00",
        totalEarnedRaw: "9000000",
      },
      {
        to: CAROL,
        bps: 2_000,
        sharePercent: "20.00",
        totalEarnedRaw: "6000000",
      },
    ]);
  });

  it("preserves stroop precision past the range of a double", async () => {
    // A single tip larger than Number.MAX_SAFE_INTEGER. Routed through a
    // float, the halves would come back as rounded, equal-looking numbers.
    tips = [9_007_199_254_740_993n * 2n];
    creatorRow = {
      walletAddress: OWNER,
      splits: [
        { to: ALICE, bps: 5_000 },
        { to: BOB, bps: 5_000 },
      ],
      updatedAt: SPLITS_UPDATED_AT,
    };

    const result = await getCollaboratorEarnings(CREATOR_ID);

    expect(result.totalAmountRaw).toBe("18014398509481986");
    expect(result.collaborators[0]?.totalEarnedRaw).toBe("9007199254740993");
    expect(result.collaborators[1]?.totalEarnedRaw).toBe("9007199254740993");
  });

  it("keeps every amount a string, never a number", async () => {
    tips = [10_000_000n];

    const result = await getCollaboratorEarnings(CREATOR_ID);

    expect(typeof result.totalAmountRaw).toBe("string");
    expect(typeof result.unallocatedRaw).toBe("string");
    for (const row of result.collaborators) {
      expect(typeof row.totalEarnedRaw).toBe("string");
    }
  });

  it("truncates each tip's share in the query, not the jar total", async () => {
    // A three-way 3333/3333/3334 split over many small tips: rounding dust is
    // lost per transfer on chain, so the breakdown has to be summed per tip.
    // Applying the percentage to the total instead would overstate each share.
    tips = Array.from({ length: 7 }, () => 1_001n);
    creatorRow = {
      walletAddress: OWNER,
      splits: [
        { to: ALICE, bps: 3_333 },
        { to: BOB, bps: 3_333 },
        { to: CAROL, bps: 3_334 },
      ],
      updatedAt: SPLITS_UPDATED_AT,
    };

    const result = await getCollaboratorEarnings(CREATOR_ID);

    // floor(1001 * 3333 / 10000) = 333 per tip, not floor(7007 * 3333/10000).
    expect(result.collaborators[0]?.totalEarnedRaw).toBe("2331");
    expect(lastQuery?.sql).toContain("floor(");
    // The bps land as query parameters rather than being pasted into the SQL.
    expect(lastQuery?.values).toContain(3_333);
  });

  it("reports the rounding dust rather than letting the numbers not add up", async () => {
    tips = Array.from({ length: 7 }, () => 1_001n);
    creatorRow = {
      walletAddress: OWNER,
      splits: [
        { to: ALICE, bps: 3_333 },
        { to: BOB, bps: 3_333 },
        { to: CAROL, bps: 3_334 },
      ],
      updatedAt: SPLITS_UPDATED_AT,
    };

    const result = await getCollaboratorEarnings(CREATOR_ID);

    const allocated = result.collaborators.reduce(
      (sum, row) => sum + BigInt(row.totalEarnedRaw),
      0n,
    );
    expect(allocated + BigInt(result.unallocatedRaw)).toBe(
      BigInt(result.totalAmountRaw),
    );
    expect(result.unallocatedRaw).not.toBe("0");
  });

  it("reports the balance when splits do not sum to 10000 bps", async () => {
    // The contract pays the remainder to the jar owner.
    tips = [10_000_000n];
    creatorRow = {
      walletAddress: OWNER,
      splits: [{ to: ALICE, bps: 2_500 }],
      updatedAt: SPLITS_UPDATED_AT,
    };

    const result = await getCollaboratorEarnings(CREATOR_ID);

    expect(result.collaborators[0]?.totalEarnedRaw).toBe("2500000");
    expect(result.unallocatedRaw).toBe("7500000");
  });

  it("handles a creator with no tips yet", async () => {
    tips = [];

    const result = await getCollaboratorEarnings(CREATOR_ID);

    expect(result.tipCount).toBe(0);
    expect(result.totalAmountRaw).toBe("0");
    expect(result.unallocatedRaw).toBe("0");
    expect(result.collaborators.map((c) => c.totalEarnedRaw)).toEqual([
      "0",
      "0",
      "0",
    ]);
  });

  describe("an unshared jar", () => {
    beforeEach(() => {
      creatorRow = {
        walletAddress: OWNER,
        splits: [],
        updatedAt: SPLITS_UPDATED_AT,
      };
      tips = [10_000_000n];
    });

    it("reports the owner at 100% rather than an empty list", async () => {
      // An empty list reads as "nobody earned anything", which is wrong: with
      // no splits recorded the contract pays the whole transfer to the owner.
      const result = await getCollaboratorEarnings(CREATOR_ID);

      expect(result.collaborators).toEqual([
        {
          to: OWNER,
          bps: 10_000,
          sharePercent: "100.00",
          totalEarnedRaw: "10000000",
        },
      ]);
      expect(result.unallocatedRaw).toBe("0");
    });

    it("flags that the row is implied, not stored", async () => {
      const result = await getCollaboratorEarnings(CREATOR_ID);
      expect(result.basis.impliedOwnerSplit).toBe(true);
    });
  });

  // ── Tips indexed before a split change ──────────────────────────────────────

  describe("basis", () => {
    it("states that current splits are applied to every indexed tip", async () => {
      tips = [10_000_000n];

      const result = await getCollaboratorEarnings(CREATOR_ID);

      expect(result.basis.mode).toBe("current-splits");
      expect(result.basis.note).toMatch(/earlier split/);
      expect(result.basis.note).toMatch(/approximates/);
    });

    it("carries splitsUpdatedAt so a caller can tell which tips are exact", async () => {
      tips = [10_000_000n];

      const result = await getCollaboratorEarnings(CREATOR_ID);

      expect(result.basis.splitsUpdatedAt).toBe(
        SPLITS_UPDATED_AT.toISOString(),
      );
    });
  });

  it("404s a creator id with no record", async () => {
    creatorRow = null;

    await expect(getCollaboratorEarnings(CREATOR_ID)).rejects.toHaveProperty(
      "statusCode",
      404,
    );
  });
});
