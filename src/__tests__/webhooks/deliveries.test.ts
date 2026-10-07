/**
 * __tests__/webhooks/deliveries.test.ts
 *
 * Covers the delivery-history endpoint: listWebhookDeliveries and the paging
 * bounds its route enforces.
 *
 * Every dispatch attempt has always been recorded in WebhookDelivery, and
 * nothing ever read a row back out. A creator whose receiver started returning
 * 500 had no way to see that, or to see what their server actually replied —
 * the failure was silent from outside the database. These tests pin the three
 * things that make the history usable: newest first, a bounded page, and the
 * response body coming back with the status code.
 *
 * config.ts validates required env vars at module load, so those are set
 * before the module graph is imported.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const { createFakeDb } = await import("./fake-db.helper.js");

type Fake = ReturnType<typeof createFakeDb>;

let fake: Fake;

jest.unstable_mockModule("../../db.js", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, property: string) =>
        (fake.db as Record<string, unknown>)[property],
    },
  ),
  disconnectDb: async (): Promise<void> => undefined,
}));

const {
  listWebhookDeliveries,
  dispatchWebhooks,
  DEFAULT_DELIVERY_PAGE_SIZE,
  MAX_DELIVERY_PAGE_SIZE,
} = await import("../../modules/webhooks/webhooks.service.js");

const { DeliveryQuery } =
  await import("../../modules/webhooks/webhooks.routes.js");

const CREATOR = "creator_alice";
const OTHER_CREATOR = "creator_bob";

beforeEach(() => {
  fake = createFakeDb();
});

/** Ids in the order returned, for ordering assertions. */
function idsOf(rows: readonly object[]): string[] {
  return rows.map((row) => (row as { id: string }).id);
}

// ── Ownership ─────────────────────────────────────────────────────────────────

describe("listWebhookDeliveries ownership", () => {
  it("returns null for a webhook belonging to another creator", async () => {
    const webhook = fake.seedWebhook({ creatorId: OTHER_CREATOR });
    fake.seedDelivery({ webhookId: webhook.id });

    await expect(
      listWebhookDeliveries(CREATOR, webhook.id),
    ).resolves.toBeNull();
  });

  it("returns null for an id that does not exist", async () => {
    await expect(
      listWebhookDeliveries(CREATOR, "wh_missing"),
    ).resolves.toBeNull();
  });

  it("returns an empty array for an owned webhook that has not fired", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });

    // Distinct from null: the route answers 200 [] here and 404 above, so a
    // creator can tell "nothing delivered yet" from "wrong id".
    await expect(listWebhookDeliveries(CREATOR, webhook.id)).resolves.toEqual(
      [],
    );
  });

  it("does not leak attempts belonging to another webhook", async () => {
    const mine = fake.seedWebhook({ creatorId: CREATOR });
    const theirs = fake.seedWebhook({ creatorId: OTHER_CREATOR });
    const ours = fake.seedDelivery({ webhookId: mine.id });
    fake.seedDelivery({ webhookId: theirs.id });

    const rows = await listWebhookDeliveries(CREATOR, mine.id);

    expect(idsOf(rows ?? [])).toEqual([ours.id]);
  });
});

// ── Ordering and paging ───────────────────────────────────────────────────────

describe("listWebhookDeliveries paging", () => {
  it("returns attempts newest first", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    const first = fake.seedDelivery({ webhookId: webhook.id });
    const second = fake.seedDelivery({ webhookId: webhook.id });
    const third = fake.seedDelivery({ webhookId: webhook.id });

    const rows = await listWebhookDeliveries(CREATOR, webhook.id);

    expect(idsOf(rows ?? [])).toEqual([third.id, second.id, first.id]);
  });

  it("defaults to a page of DEFAULT_DELIVERY_PAGE_SIZE", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    for (let i = 0; i < DEFAULT_DELIVERY_PAGE_SIZE + 5; i += 1) {
      fake.seedDelivery({ webhookId: webhook.id });
    }

    const rows = await listWebhookDeliveries(CREATOR, webhook.id);

    expect(rows).toHaveLength(DEFAULT_DELIVERY_PAGE_SIZE);
  });

  it("caps a page at MAX_DELIVERY_PAGE_SIZE even when asked for more", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    for (let i = 0; i < MAX_DELIVERY_PAGE_SIZE + 10; i += 1) {
      fake.seedDelivery({ webhookId: webhook.id });
    }

    // The route rejects an over-limit query, but the service is callable
    // directly and must not be the place an unbounded page gets through.
    const rows = await listWebhookDeliveries(
      CREATOR,
      webhook.id,
      MAX_DELIVERY_PAGE_SIZE + 10,
    );

    expect(rows).toHaveLength(MAX_DELIVERY_PAGE_SIZE);
  });

  it("walks back through history with offset", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    const seeded = [
      fake.seedDelivery({ webhookId: webhook.id }),
      fake.seedDelivery({ webhookId: webhook.id }),
      fake.seedDelivery({ webhookId: webhook.id }),
      fake.seedDelivery({ webhookId: webhook.id }),
    ];
    const newestFirst = [...seeded].reverse();

    const page = await listWebhookDeliveries(CREATOR, webhook.id, 2, 2);

    expect(idsOf(page ?? [])).toEqual([newestFirst[2]?.id, newestFirst[3]?.id]);
  });
});

// ── Row shape ─────────────────────────────────────────────────────────────────

describe("delivery rows", () => {
  it("carry the status code, success flag, response and attempt time", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    const attemptedAt = new Date("2026-03-04T05:06:07.008Z");
    fake.seedDelivery({
      webhookId: webhook.id,
      statusCode: 500,
      success: false,
      response: "Internal Server Error",
      attemptedAt,
    });

    const rows = await listWebhookDeliveries(CREATOR, webhook.id);

    expect(rows?.[0]).toMatchObject({
      statusCode: 500,
      success: false,
      response: "Internal Server Error",
      attemptedAt,
    });
  });

  it("omit the request payload", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    fake.seedDelivery({
      webhookId: webhook.id,
      payload: { event: "tip.received", message: "secret-ish" },
    });

    const rows = await listWebhookDeliveries(CREATOR, webhook.id);

    expect(rows?.[0]).not.toHaveProperty("payload");
  });
});

// ── What a real failure looks like when read back ─────────────────────────────

describe("history of a dispatch that failed", () => {
  const mockFetch = jest.fn<typeof fetch>();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const tip = {
    jarId: "@alice",
    from: `G${"A".repeat(55)}`,
    amount: 25_000_000n,
    message: "nice work",
    ledger: 1_234,
    timestamp: "2026-01-01T00:00:00Z",
    txHash: "a".repeat(64),
  };

  it("surfaces the status code and body a broken receiver returned", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "signature mismatch",
    } as unknown as Response);

    await dispatchWebhooks(tip);
    const rows = await listWebhookDeliveries(CREATOR, webhook.id);

    // This is the whole point of the endpoint: the creator can now see that
    // their own signature check is what rejected the delivery.
    expect(rows?.[0]).toMatchObject({
      statusCode: 422,
      success: false,
      response: "signature mismatch",
    });
  });

  it("reports a null status code when the request never completed", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await dispatchWebhooks(tip);
    const rows = await listWebhookDeliveries(CREATOR, webhook.id);

    // A timeout or a refused connection has no HTTP status; null records that
    // honestly, and the transport error lands in `response` instead.
    expect(rows?.[0]).toMatchObject({ statusCode: null, success: false });
    expect(rows?.[0]?.response).toContain("ECONNREFUSED");
  });
});

// ── Route-level bounds ────────────────────────────────────────────────────────

describe("DeliveryQuery", () => {
  it("defaults an absent limit and offset", () => {
    expect(DeliveryQuery.parse({})).toEqual({
      limit: DEFAULT_DELIVERY_PAGE_SIZE,
      offset: 0,
    });
  });

  it("coerces the strings Fastify hands over", () => {
    expect(DeliveryQuery.parse({ limit: "25", offset: "50" })).toEqual({
      limit: 25,
      offset: 50,
    });
  });

  it("accepts the ceiling exactly", () => {
    expect(
      DeliveryQuery.parse({ limit: String(MAX_DELIVERY_PAGE_SIZE) }).limit,
    ).toBe(MAX_DELIVERY_PAGE_SIZE);
  });

  it.each([
    ["above the ceiling", { limit: String(MAX_DELIVERY_PAGE_SIZE + 1) }],
    ["zero", { limit: "0" }],
    ["negative", { limit: "-1" }],
    ["fractional", { limit: "1.5" }],
    ["not a number", { limit: "all" }],
    ["a negative offset", { offset: "-1" }],
  ])("rejects %s", (_label, query) => {
    // Rejected rather than clamped: a caller paging through history needs to
    // know its page was shortened, and silently returning 100 for ?limit=500
    // looks like the history simply ends there.
    expect(DeliveryQuery.safeParse(query).success).toBe(false);
  });
});
