/**
 * __tests__/webhooks/ping.test.ts
 *
 * Covers the test-ping endpoint (sendTestPing).
 *
 * The gap it closes: a creator registering a webhook could not tell whether it
 * worked until a real tip arrived, so a wrong URL or a broken signature check
 * announced itself by a missed tip notification. The ping only has value if it
 * is a faithful rehearsal, so these tests pin that it uses the same method,
 * the same header and the same HMAC as a real dispatch — and that the payload
 * is unmistakably a test, so no receiver books a tip from it.
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

const { sendTestPing, dispatchWebhooks, listWebhookDeliveries } =
  await import("../../modules/webhooks/webhooks.service.js");

const CREATOR = "creator_alice";
const OTHER_CREATOR = "creator_bob";
const SECRET = "ping-secret-at-least-32-chars-ok";
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

/** The single request sendTestPing made. */
function lastRequest(): { url: string; init: RequestInit } {
  const call = mockFetch.mock.calls[0];
  if (call === undefined) throw new Error("no request was made");
  return { url: String(call[0]), init: call[1] ?? {} };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

// ── Ownership ─────────────────────────────────────────────────────────────────

describe("sendTestPing ownership", () => {
  it("returns null for a webhook belonging to another creator", async () => {
    const webhook = fake.seedWebhook({ creatorId: OTHER_CREATOR, url: URL });

    await expect(sendTestPing(CREATOR, webhook.id)).resolves.toBeNull();

    // And crucially sends nothing: otherwise the route would be a way to make
    // the server POST to a URL the caller does not own.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fake.deliveries).toHaveLength(0);
  });

  it("returns null for an id that does not exist", async () => {
    await expect(sendTestPing(CREATOR, "wh_missing")).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("pings a disabled webhook", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR, enabled: false });

    // The intended repair loop is pause → fix → ping → re-enable, so the
    // flag must not gate an explicit request from the owner.
    await expect(sendTestPing(CREATOR, webhook.id)).resolves.toMatchObject({
      success: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── The request ───────────────────────────────────────────────────────────────

describe("the ping request", () => {
  beforeEach(() => {
    fake.seedWebhook({ creatorId: CREATOR, url: URL, secret: SECRET });
  });

  async function ping(): Promise<void> {
    const [webhook] = [...fake.webhooks.values()];
    await sendTestPing(CREATOR, webhook!.id);
  }

  it("POSTs JSON to the webhook's URL", async () => {
    await ping();

    const { url, init } = lastRequest();
    expect(url).toBe(URL);
    expect(init.method).toBe("POST");
    expect(headerOf(init, "Content-Type")).toBe("application/json");
  });

  it("signs the body with the webhook's secret, exactly as a tip is signed", async () => {
    await ping();

    const { init } = lastRequest();
    const expected = createHmac("sha256", SECRET)
      .update(String(init.body))
      .digest("hex");

    // Same header, same algorithm, same secret — the receiver's existing
    // verification code is what is under test on their side.
    expect(headerOf(init, "X-Novatip-Signature")).toBe(`sha256=${expected}`);
  });

  it("produces a signature a tip-shaped verifier would reject under the wrong secret", async () => {
    await ping();

    const { init } = lastRequest();
    const wrong = createHmac("sha256", "not-the-secret")
      .update(String(init.body))
      .digest("hex");

    expect(headerOf(init, "X-Novatip-Signature")).not.toBe(`sha256=${wrong}`);
  });

  it("marks the payload as a test twice over", async () => {
    await ping();

    const body = bodyOf(lastRequest().init);
    expect(body["event"]).toBe("webhook.test");
    expect(body["test"]).toBe(true);
  });

  it("is not mistakable for a tip payload", async () => {
    await ping();

    const body = bodyOf(lastRequest().init);
    expect(body["event"]).not.toBe("tip.received");
    // No amount, sender or jar: a receiver that ignores both markers still
    // has no tip to reconstruct.
    expect(body).not.toHaveProperty("amount");
    expect(body).not.toHaveProperty("amountRaw");
    expect(body).not.toHaveProperty("from");
    expect(body).not.toHaveProperty("jarId");
  });

  it("identifies which webhook was pinged, and when", async () => {
    const [webhook] = [...fake.webhooks.values()];
    await ping();

    const body = bodyOf(lastRequest().init);
    expect(body["webhookId"]).toBe(webhook!.id);
    expect(Date.parse(String(body["timestamp"]))).not.toBeNaN();
  });

  it("never puts the secret in the body or the outcome", async () => {
    const [webhook] = [...fake.webhooks.values()];
    const outcome = await sendTestPing(CREATOR, webhook!.id);

    expect(String(lastRequest().init.body)).not.toContain(SECRET);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
});

// ── The outcome ───────────────────────────────────────────────────────────────

describe("the reported outcome", () => {
  let webhookId: string;

  beforeEach(() => {
    webhookId = fake.seedWebhook({ creatorId: CREATOR, url: URL }).id;
  });

  it("reports a 2xx as a success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
    } as unknown as Response);

    await expect(sendTestPing(CREATOR, webhookId)).resolves.toMatchObject({
      statusCode: 204,
      success: true,
    });
  });

  it("reports the status and body of a rejection", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "bad signature",
    } as unknown as Response);

    // This is the failure the ping exists to surface: the creator's own
    // verification rejecting a correctly signed delivery.
    await expect(sendTestPing(CREATOR, webhookId)).resolves.toMatchObject({
      statusCode: 401,
      success: false,
      response: "bad signature",
    });
  });

  it("reports a null status when the request never completed", async () => {
    mockFetch.mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND typo.example"),
    );

    const outcome = await sendTestPing(CREATOR, webhookId);

    expect(outcome).toMatchObject({ statusCode: null, success: false });
    expect(outcome?.response).toContain("ENOTFOUND");
  });

  it("does not throw when the receiver is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(sendTestPing(CREATOR, webhookId)).resolves.not.toBeNull();
  });

  it("matches the row the delivery history will show", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    } as unknown as Response);

    const outcome = await sendTestPing(CREATOR, webhookId);
    const history = await listWebhookDeliveries(CREATOR, webhookId);

    // Reported from the stored row, so the two cannot drift apart.
    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({
      statusCode: outcome?.statusCode,
      success: outcome?.success,
      response: outcome?.response,
      attemptedAt: outcome?.attemptedAt,
    });
  });

  it("records the test payload against the webhook", async () => {
    await sendTestPing(CREATOR, webhookId);

    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]?.webhookId).toBe(webhookId);
    expect(fake.deliveries[0]?.payload).toMatchObject({
      event: "webhook.test",
      test: true,
    });
  });
});

// ── The shared store path ─────────────────────────────────────────────────────

describe("stored payload bounding", () => {
  const tip = {
    jarId: "@alice",
    from: `G${"A".repeat(55)}`,
    amount: 25_000_000n,
    message: "x".repeat(4_000),
    ledger: 1_234,
    timestamp: "2026-01-01T00:00:00Z",
    txHash: "a".repeat(64),
  };

  it("trims an oversized tip message before storing it", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    fake.seedWebhook({ creatorId: CREATOR, url: URL });

    await dispatchWebhooks(tip);

    // The 2 KB bound now actually applies to the stored copy. The body that
    // went over the wire is untrimmed — only the diagnostic copy is reduced.
    const stored = fake.deliveries[0]?.payload as { message: string };
    expect(stored.message.length).toBeLessThan(tip.message.length);
    expect(stored.message.endsWith("…")).toBe(true);
    expect(String(lastRequest().init.body)).toContain("x".repeat(4_000));
  });

  it("leaves a test payload alone — it cannot reach the bound", async () => {
    const webhookId = fake.seedWebhook({ creatorId: CREATOR, url: URL }).id;

    await sendTestPing(CREATOR, webhookId);

    expect(fake.deliveries[0]?.payload).toEqual(
      bodyOf(lastRequest().init) as object,
    );
  });
});
