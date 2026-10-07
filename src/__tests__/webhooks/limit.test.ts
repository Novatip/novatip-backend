/**
 * __tests__/webhooks/limit.test.ts
 *
 * Covers the per-creator webhook cap.
 *
 * The regression under test: POST /webhooks had no limit, so a creator could
 * register any number of endpoints. dispatchWebhooks fans out to every enabled
 * one on each indexed tip — each with its own five second timeout and its own
 * delivery row — so one tip turned into an unbounded amount of outbound work
 * inside the indexer's event handling.
 *
 * db is mocked so this runs without PostgreSQL: what is under test is the
 * decision and the transaction around it, not Prisma. config.ts validates
 * required env vars at module load, so those are set before the module graph
 * is imported — including the cap itself, which is read from the environment.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["MAX_WEBHOOKS_PER_CREATOR"] = "3";

const CREATOR = "creator_1";

/** How many webhooks the mocked creator currently holds. */
let existingCount = 0;

const created: Array<{ creatorId: string; url: string; secret: string }> = [];

const webhookDelegate = {
  count: async (): Promise<number> => existingCount,
  create: async ({
    data,
  }: {
    data: { creatorId: string; url: string; secret: string };
  }) => {
    created.push(data);
    existingCount += 1;
    return { id: `wh_${created.length}`, enabled: true, ...data };
  },
};

/** Annotated rather than inferred: $transaction hands back the client itself. */
interface MockDb {
  webhook: typeof webhookDelegate;
  $transaction: <T>(fn: (tx: MockDb) => Promise<T>) => Promise<T>;
}

const mockDb: MockDb = {
  webhook: webhookDelegate,
  // Interactive transaction: run the callback against the same delegates, so
  // the count-then-insert sequence under test actually executes.
  $transaction: async <T>(fn: (tx: MockDb) => Promise<T>): Promise<T> =>
    fn(mockDb),
};

jest.unstable_mockModule("../../db.js", () => ({
  db: mockDb,
  disconnectDb: async (): Promise<void> => undefined,
}));

const { assertWebhookLimit, webhookLimit, WEBHOOK_LIMIT_CODE } =
  await import("../../modules/webhooks/limit.js");
const { createWebhook } =
  await import("../../modules/webhooks/webhooks.service.js");

beforeEach(() => {
  existingCount = 0;
  created.length = 0;
});

// ── The configured limit ──────────────────────────────────────────────────────

describe("webhookLimit", () => {
  it("reads the cap from the environment", () => {
    expect(webhookLimit()).toBe(3);
  });
});

// ── The decision ──────────────────────────────────────────────────────────────

describe("assertWebhookLimit", () => {
  describe("boundary", () => {
    test.each([0, 1, 2])("allows registration number %i of 3", (count) => {
      expect(() => assertWebhookLimit(count, 3)).not.toThrow();
    });

    it("rejects the registration that would make it 4", () => {
      expect(() => assertWebhookLimit(3, 3)).toThrow();
    });

    it("rejects a creator already over the cap", () => {
      // Rows predating the cap, or a cap lowered after the fact: the creator
      // is not allowed to add more, but is not otherwise disturbed.
      expect(() => assertWebhookLimit(9, 3)).toThrow();
    });
  });

  describe("the rejection", () => {
    it("is a 409, not a 500", () => {
      // Route handlers let this reach the global error handler, which falls
      // back to 500 for anything without a statusCode. A client at its quota
      // must not read as a server fault.
      expect(() => assertWebhookLimit(3, 3)).toThrow(
        expect.objectContaining({ statusCode: 409 }) as Error,
      );
    });

    it("carries a code clients can branch on", () => {
      expect(() => assertWebhookLimit(3, 3)).toThrow(
        expect.objectContaining({ code: WEBHOOK_LIMIT_CODE }) as Error,
      );
      expect(WEBHOOK_LIMIT_CODE).toBe("WEBHOOK_LIMIT_REACHED");
    });

    it("names the limit and the env var that sets it", () => {
      expect(() => assertWebhookLimit(3, 3)).toThrow(/at most 3 webhooks/);
      expect(() => assertWebhookLimit(3, 3)).toThrow(
        /MAX_WEBHOOKS_PER_CREATOR/,
      );
    });

    it('says "webhook" rather than "webhooks" for a cap of one', () => {
      expect(() => assertWebhookLimit(1, 1)).toThrow(/at most 1 webhook \(/);
    });
  });

  describe("unlimited", () => {
    it("allows any count when the cap is removed", () => {
      expect(() => assertWebhookLimit(10_000, null)).not.toThrow();
    });
  });
});

// ── Through the service ───────────────────────────────────────────────────────

describe("createWebhook", () => {
  it("registers up to the cap", async () => {
    for (let i = 0; i < 3; i++) {
      await createWebhook(
        CREATOR,
        `https://hooks.example.com/${i}`,
        "s".repeat(24),
      );
    }
    expect(created).toHaveLength(3);
  });

  it("rejects the one past the cap without inserting a row", async () => {
    existingCount = 3;

    await expect(
      createWebhook(CREATOR, "https://hooks.example.com/4", "s".repeat(24)),
    ).rejects.toThrow(/at most 3 webhooks/);

    expect(created).toHaveLength(0);
  });

  it("counts every row the creator holds, enabled or not", async () => {
    // The count is unfiltered on `enabled` on purpose: a disabled webhook is
    // one the creator can flip back on, so excluding them would make the cap
    // trivial to walk around.
    const countSpy = jest.spyOn(webhookDelegate, "count");
    existingCount = 1;

    await createWebhook(CREATOR, "https://hooks.example.com/x", "s".repeat(24));

    expect(countSpy).toHaveBeenCalledWith({ where: { creatorId: CREATOR } });
    countSpy.mockRestore();
  });

  it("checks and inserts inside one transaction", async () => {
    // Two concurrent registrations that each read the pre-insert count would
    // otherwise both pass the check and leave the creator one over the cap.
    const txSpy = jest.spyOn(mockDb, "$transaction");

    await createWebhook(CREATOR, "https://hooks.example.com/y", "s".repeat(24));

    expect(txSpy).toHaveBeenCalledTimes(1);
    txSpy.mockRestore();
  });
});
