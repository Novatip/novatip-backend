/**
 * __tests__/webhooks/rotate-secret.test.ts
 *
 * Covers secret rotation (rotateWebhookSecret, generateWebhookSecret).
 *
 * The gap it closes: the signing secret was minted once at registration and
 * shown in that single response. A leaked or lost secret could only be dealt
 * with by deleting the webhook and creating another, which changes its id and
 * discards its delivery history — a lot to surrender to replace a credential.
 *
 * So the tests here are mostly about what rotation must *not* disturb: the id,
 * the URL, the enabled flag, and every recorded attempt. The one thing that
 * must change is which key signs the next delivery, verified by recomputing
 * the HMAC both ways.
 *
 * config.ts validates required env vars at module load, so those are set
 * before the module graph is imported.
 */

import { jest } from "@jest/globals";
import { createHmac } from "crypto";

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
  rotateWebhookSecret,
  generateWebhookSecret,
  dispatchWebhooks,
  sendTestPing,
  listWebhookDeliveries,
  setWebhookEnabled,
} = await import("../../modules/webhooks/webhooks.service.js");

const CREATOR = "creator_alice";
const OTHER_CREATOR = "creator_bob";
const OLD_SECRET = "the-original-secret-32-chars-ok!";
const URL = "https://hooks.example.com/novatip";

const mockFetch = jest.fn<typeof fetch>();
const realFetch = globalThis.fetch;

beforeEach(() => {
  fake = createFakeDb();
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

/** The body and signature header of the nth request made. */
function requestAt(index: number): { body: string; signature: string } {
  const call = mockFetch.mock.calls[index];
  if (call === undefined) throw new Error(`no request at index ${index}`);
  const init = call[1] ?? {};
  const headers = init.headers as Record<string, string> | undefined;
  return {
    body: String(init.body),
    signature: headers?.["X-Novatip-Signature"] ?? "",
  };
}

function signatureFor(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// ── Generation ────────────────────────────────────────────────────────────────

describe("generateWebhookSecret", () => {
  it("returns 24 bytes as hex", () => {
    expect(generateWebhookSecret()).toMatch(/^[0-9a-f]{48}$/);
  });

  it("returns a different secret every time", () => {
    const secrets = new Set(
      Array.from({ length: 50 }, () => generateWebhookSecret()),
    );

    expect(secrets.size).toBe(50);
  });
});

// ── Ownership ─────────────────────────────────────────────────────────────────

describe("rotateWebhookSecret ownership", () => {
  it("returns null for a webhook belonging to another creator", async () => {
    const webhook = fake.seedWebhook({
      creatorId: OTHER_CREATOR,
      secret: OLD_SECRET,
    });

    await expect(rotateWebhookSecret(CREATOR, webhook.id)).resolves.toBeNull();

    // And leaves their secret alone — rotating someone else's secret would
    // break their receiver, which is a denial of service, not a leak.
    expect(fake.webhooks.get(webhook.id)?.secret).toBe(OLD_SECRET);
  });

  it("returns null for an id that does not exist", async () => {
    await expect(
      rotateWebhookSecret(CREATOR, "wh_missing"),
    ).resolves.toBeNull();
  });
});

// ── What changes ──────────────────────────────────────────────────────────────

describe("the new secret", () => {
  it("is returned once, alongside the webhook", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      secret: OLD_SECRET,
    });

    const rotated = await rotateWebhookSecret(CREATOR, webhook.id);

    expect(rotated?.secret).toMatch(/^[0-9a-f]{48}$/);
    expect(rotated?.secret).not.toBe(OLD_SECRET);
  });

  it("is what was stored", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      secret: OLD_SECRET,
    });

    const rotated = await rotateWebhookSecret(CREATOR, webhook.id);

    expect(fake.webhooks.get(webhook.id)?.secret).toBe(rotated?.secret);
  });

  it("differs on each rotation", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      secret: OLD_SECRET,
    });

    const first = await rotateWebhookSecret(CREATOR, webhook.id);
    const second = await rotateWebhookSecret(CREATOR, webhook.id);

    expect(second?.secret).not.toBe(first?.secret);
  });

  it("can be chosen by the caller, as at registration", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      secret: OLD_SECRET,
    });
    const chosen = "a-secret-i-picked-myself-32-chr";

    const rotated = await rotateWebhookSecret(CREATOR, webhook.id, chosen);

    expect(rotated?.secret).toBe(chosen);
    expect(fake.webhooks.get(webhook.id)?.secret).toBe(chosen);
  });
});

// ── What does not change ──────────────────────────────────────────────────────

describe("rotation preserves the webhook", () => {
  it("keeps the id, so references to it still resolve", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      secret: OLD_SECRET,
    });

    const rotated = await rotateWebhookSecret(CREATOR, webhook.id);

    expect(rotated?.id).toBe(webhook.id);
    expect(fake.webhooks.size).toBe(1);
  });

  it("keeps the URL and the createdAt", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      url: URL,
      secret: OLD_SECRET,
    });

    const rotated = await rotateWebhookSecret(CREATOR, webhook.id);

    expect(rotated).toMatchObject({
      url: URL,
      createdAt: webhook.createdAt,
    });
  });

  it("does not re-enable a disabled webhook", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      secret: OLD_SECRET,
      enabled: false,
    });

    const rotated = await rotateWebhookSecret(CREATOR, webhook.id);

    // Rotating during a pause is the documented zero-downtime recipe, so it
    // must not quietly resume deliveries mid-repair.
    expect(rotated?.enabled).toBe(false);
    expect(fake.webhooks.get(webhook.id)?.enabled).toBe(false);
  });

  it("keeps the delivery history", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      secret: OLD_SECRET,
    });
    const seeded = [
      fake.seedDelivery({ webhookId: webhook.id, statusCode: 200 }),
      fake.seedDelivery({ webhookId: webhook.id, statusCode: 500 }),
      fake.seedDelivery({ webhookId: webhook.id, statusCode: 404 }),
    ];

    await rotateWebhookSecret(CREATOR, webhook.id);
    const history = await listWebhookDeliveries(CREATOR, webhook.id);

    expect(history).toHaveLength(seeded.length);
    expect(history?.map((row) => row.statusCode)).toEqual([404, 500, 200]);
  });
});

// ── What the new secret is for ────────────────────────────────────────────────

describe("deliveries after rotation", () => {
  it("are signed with the new secret, not the old one", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      url: URL,
      secret: OLD_SECRET,
    });

    await dispatchWebhooks(tip);
    const before = requestAt(0);
    expect(before.signature).toBe(signatureFor(before.body, OLD_SECRET));

    const rotated = await rotateWebhookSecret(CREATOR, webhook.id);
    await dispatchWebhooks(tip);
    const after = requestAt(1);

    // Same body, different key — so the signature is the only thing that
    // moved, and it moved to the secret the creator was just handed.
    expect(after.body).toBe(before.body);
    expect(after.signature).toBe(signatureFor(after.body, rotated!.secret));
    expect(after.signature).not.toBe(before.signature);
  });

  it("no longer verify under the old secret", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      url: URL,
      secret: OLD_SECRET,
    });

    await rotateWebhookSecret(CREATOR, webhook.id);
    await dispatchWebhooks(tip);
    const sent = requestAt(0);

    // No overlap window is deliberate: a secret rotated because it leaked
    // needs the old one dead immediately, not accepted alongside the new.
    expect(sent.signature).not.toBe(signatureFor(sent.body, OLD_SECRET));
  });

  it("include a test ping, so the new secret can be verified before a real tip", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      url: URL,
      secret: OLD_SECRET,
    });

    const rotated = await rotateWebhookSecret(CREATOR, webhook.id);
    await sendTestPing(CREATOR, webhook.id);
    const sent = requestAt(0);

    expect(sent.signature).toBe(signatureFor(sent.body, rotated!.secret));
  });

  it("resume under the new secret after the disable/rotate/re-enable recipe", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      url: URL,
      secret: OLD_SECRET,
    });

    // The documented zero-downtime rotation, end to end.
    await setWebhookEnabled(CREATOR, webhook.id, false);
    const rotated = await rotateWebhookSecret(CREATOR, webhook.id);

    await dispatchWebhooks(tip);
    expect(mockFetch).not.toHaveBeenCalled();

    await setWebhookEnabled(CREATOR, webhook.id, true);
    await dispatchWebhooks(tip);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = requestAt(0);
    expect(sent.signature).toBe(signatureFor(sent.body, rotated!.secret));
  });
});
