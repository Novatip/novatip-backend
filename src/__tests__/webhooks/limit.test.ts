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
 * db is mocked through the shared fake (see fake-db.helper.ts) so this runs
 * without PostgreSQL. config.ts validates required env vars at module load, so
 * those are set before the module graph is imported — including the cap
 * itself, which is read from the environment.
 */

import { jest } from "@jest/globals";
import { createFakeDb } from "./fake-db.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["MAX_WEBHOOKS_PER_CREATOR"] = "3";

const CREATOR = "creator_1";
const OTHER_CREATOR = "creator_2";

const fake = createFakeDb();

jest.unstable_mockModule("../../db.js", () => ({
  db: fake.db,
  disconnectDb: async (): Promise<void> => undefined,
}));

const { assertWebhookLimit, webhookLimit, WEBHOOK_LIMIT_CODE } =
  await import("../../modules/webhooks/limit.js");
const { createWebhook, setWebhookEnabled } =
  await import("../../modules/webhooks/webhooks.service.js");

/** Register one webhook, with a distinct URL so rows are tellable apart. */
function register(creatorId = CREATOR, n = 0): Promise<unknown> {
  return createWebhook(
    creatorId,
    `https://hooks.example.com/${creatorId}/${n}`,
    "s".repeat(24),
  );
}

beforeEach(() => {
  fake.webhooks.clear();
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
    for (let i = 0; i < 3; i++) await register(CREATOR, i);
    expect(fake.webhooks.size).toBe(3);
  });

  it("rejects the one past the cap without inserting a row", async () => {
    for (let i = 0; i < 3; i++) await register(CREATOR, i);

    await expect(register(CREATOR, 4)).rejects.toThrow(/at most 3 webhooks/);

    expect(fake.webhooks.size).toBe(3);
  });

  it("frees a slot when a webhook is deleted", async () => {
    // The error tells the creator to delete one to make room, so that has to
    // actually work rather than leaving them permanently stuck.
    for (let i = 0; i < 3; i++) await register(CREATOR, i);
    const [first] = [...fake.webhooks.keys()];
    fake.webhooks.delete(first as string);

    await expect(register(CREATOR, 4)).resolves.toBeDefined();
  });

  it("counts a webhook that has been disabled", async () => {
    // The count is unfiltered on `enabled` on purpose: PATCH /webhooks/:id can
    // re-enable a paused webhook at any time, so excluding disabled rows would
    // make the cap trivial to walk around — pause three, register three more.
    for (let i = 0; i < 3; i++) await register(CREATOR, i);
    for (const id of fake.webhooks.keys()) {
      await setWebhookEnabled(CREATOR, id, false);
    }

    expect([...fake.webhooks.values()].every((row) => !row.enabled)).toBe(true);
    await expect(register(CREATOR, 4)).rejects.toThrow(/at most 3 webhooks/);
  });

  it("scopes the cap per creator", async () => {
    // One creator filling their quota must not block anybody else's.
    for (let i = 0; i < 3; i++) await register(CREATOR, i);

    await expect(register(OTHER_CREATOR, 0)).resolves.toBeDefined();
  });

  it("checks and inserts inside one transaction", async () => {
    // Two concurrent registrations that each read the pre-insert count would
    // otherwise both pass the check and leave the creator one over the cap.
    const client = fake.db as { $transaction: (...args: never[]) => unknown };
    const txSpy = jest.spyOn(client, "$transaction");

    await register(CREATOR, 0);

    expect(txSpy).toHaveBeenCalledTimes(1);
    txSpy.mockRestore();
  });
});
