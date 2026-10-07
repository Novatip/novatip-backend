/**
 * __tests__/webhooks/enabled.test.ts
 *
 * Covers the enable/disable toggle (setWebhookEnabled) and the behaviour it
 * exists to give creators: a webhook can be paused and resumed without losing
 * its configuration.
 *
 * The gap it closes: the Webhook row has always carried an `enabled` flag and
 * dispatchWebhooks has always filtered on it, but no route ever wrote it. The
 * column was permanently true, so the only way to stop deliveries was to
 * delete the webhook and register it again — which issues a new secret and a
 * new id. These tests pin both halves: the write is scoped to the owner, and a
 * disabled webhook really does receive nothing while its secret survives.
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

// The service holds `db` by reference at import time, so the mock factory has
// to read through to whichever fake the current test installed.
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

const { setWebhookEnabled, dispatchWebhooks, listWebhooks } =
  await import("../../modules/webhooks/webhooks.service.js");

const CREATOR = "creator_alice";
const OTHER_CREATOR = "creator_bob";

beforeEach(() => {
  fake = createFakeDb();
});

// ── Ownership ─────────────────────────────────────────────────────────────────

describe("setWebhookEnabled", () => {
  it("disables a webhook the caller owns", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR, enabled: true });

    const updated = await setWebhookEnabled(CREATOR, webhook.id, false);

    expect(updated).toMatchObject({ id: webhook.id, enabled: false });
    expect(fake.webhooks.get(webhook.id)?.enabled).toBe(false);
  });

  it("re-enables a webhook it previously disabled", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR, enabled: false });

    const updated = await setWebhookEnabled(CREATOR, webhook.id, true);

    expect(updated).toMatchObject({ id: webhook.id, enabled: true });
  });

  it("is idempotent — sending the state it already has is a no-op", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR, enabled: false });

    await setWebhookEnabled(CREATOR, webhook.id, false);
    const second = await setWebhookEnabled(CREATOR, webhook.id, false);

    // A client retrying after a dropped response must not flip it back on.
    expect(second).toMatchObject({ enabled: false });
  });

  it("returns null for a webhook belonging to another creator", async () => {
    const webhook = fake.seedWebhook({
      creatorId: OTHER_CREATOR,
      enabled: true,
    });

    await expect(
      setWebhookEnabled(CREATOR, webhook.id, false),
    ).resolves.toBeNull();

    // And leaves it alone — the predicate carries creatorId, so the write
    // never matched in the first place.
    expect(fake.webhooks.get(webhook.id)?.enabled).toBe(true);
  });

  it("returns null for an id that does not exist", async () => {
    await expect(setWebhookEnabled(CREATOR, "wh_missing", true)).resolves.toBe(
      null,
    );
  });

  // ── Secret ──────────────────────────────────────────────────────────────────

  it("leaves the secret untouched and out of the response", async () => {
    const secret = "original-secret-value-32-chars-x";
    const webhook = fake.seedWebhook({ creatorId: CREATOR, secret });

    const disabled = await setWebhookEnabled(CREATOR, webhook.id, false);
    const enabled = await setWebhookEnabled(CREATOR, webhook.id, true);

    expect(fake.webhooks.get(webhook.id)?.secret).toBe(secret);
    expect(disabled).not.toHaveProperty("secret");
    expect(enabled).not.toHaveProperty("secret");
  });

  it("keeps the webhook's id, so references to it survive the pause", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });

    await setWebhookEnabled(CREATOR, webhook.id, false);
    const listed = await listWebhooks(CREATOR);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: webhook.id, enabled: false });
  });
});

// ── The behaviour the flag buys ───────────────────────────────────────────────

describe("dispatchWebhooks respects the flag", () => {
  const mockFetch = jest.fn<typeof fetch>();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    } as unknown as Response);
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

  it("delivers to an enabled webhook", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    fake.seedWebhook({
      creatorId: CREATOR,
      url: "https://hooks.example.com/live",
      enabled: true,
    });

    await dispatchWebhooks(tip);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://hooks.example.com/live");
  });

  it("delivers nothing to a disabled webhook, and logs no attempt", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    fake.seedWebhook({ creatorId: CREATOR, enabled: false });

    await dispatchWebhooks(tip);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(fake.deliveries).toHaveLength(0);
  });

  it("skips only the disabled one when a creator has both", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    fake.seedWebhook({
      creatorId: CREATOR,
      url: "https://hooks.example.com/live",
      enabled: true,
    });
    fake.seedWebhook({
      creatorId: CREATOR,
      url: "https://hooks.example.com/paused",
      enabled: false,
    });

    await dispatchWebhooks(tip);

    expect(mockFetch.mock.calls.map((call) => call[0])).toEqual([
      "https://hooks.example.com/live",
    ]);
  });

  it("resumes deliveries after re-enabling, signed with the same secret", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      secret: "unchanged-across-the-pause-abcd",
      enabled: true,
    });

    await dispatchWebhooks(tip);
    const before = mockFetch.mock.calls[0]?.[1]?.headers;

    await setWebhookEnabled(CREATOR, webhook.id, false);
    await dispatchWebhooks(tip);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await setWebhookEnabled(CREATOR, webhook.id, true);
    await dispatchWebhooks(tip);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Same secret, same body, so the receiver's existing verification still
    // passes — nothing had to be re-registered.
    const after = mockFetch.mock.calls[1]?.[1]?.headers;
    expect(after).toEqual(before);
  });
});
