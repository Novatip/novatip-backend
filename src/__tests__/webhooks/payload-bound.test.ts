/**
 * Stored webhook payloads are bounded independently of the full request body
 * delivered to the receiver.
 */

import { jest } from "@jest/globals";
import type { TipEvent } from "@novatip/sdk";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
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

const mockFetch = jest.fn<typeof fetch>();
const realFetch = globalThis.fetch;

const { config } = await import("../../config.js");
const { dispatchWebhooks, sendTestPing } =
  await import("../../modules/webhooks/webhooks.service.js");

const CREATOR_ID = "creator-1";
const WEBHOOK_URL = "https://hooks.example.com/novatip";

const tip: TipEvent = {
  jarId: "@alice",
  from: `G${"A".repeat(55)}`,
  amount: 25_000_000n,
  message: "Thanks for the work",
  ledger: 1_234,
  timestamp: "2026-10-20T12:34:56.000Z",
  txHash: "a".repeat(64),
};

async function withMaxPayloadSize(
  maxPayloadSize: number,
  run: () => Promise<void>,
): Promise<void> {
  const webhooks = config.webhooks as unknown as { maxPayloadSize: number };
  const original = webhooks.maxPayloadSize;
  webhooks.maxPayloadSize = maxPayloadSize;
  try {
    await run();
  } finally {
    webhooks.maxPayloadSize = original;
  }
}

function seedDispatchTarget(): string {
  fake.seedCreator({ id: CREATOR_ID, jarId: tip.jarId });
  return fake.seedWebhook({
    creatorId: CREATOR_ID,
    url: WEBHOOK_URL,
  }).id;
}

function sentPayload(): object {
  const body = mockFetch.mock.calls[0]?.[1]?.body;
  return JSON.parse(String(body)) as object;
}

beforeEach(() => {
  fake = createFakeDb();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(
    new Response("ok", { status: 200, statusText: "OK" }),
  );
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("stored webhook payload bound", () => {
  it("stores a payload under the limit unchanged", async () => {
    seedDispatchTarget();

    await withMaxPayloadSize(10_000, async () => {
      await dispatchWebhooks(tip);
    });

    expect(fake.deliveries[0]?.payload).toEqual(sentPayload());
  });

  it("truncates a long message with an ellipsis and fits the limit", async () => {
    seedDispatchTarget();
    const oversizedTip = { ...tip, message: "x".repeat(4_000) };

    await withMaxPayloadSize(600, async () => {
      await dispatchWebhooks(oversizedTip);
    });

    const stored = fake.deliveries[0]?.payload as { message: string };
    expect(stored.message).toBe(`${"x".repeat(200)}…`);
    expect(
      Buffer.byteLength(JSON.stringify(stored), "utf8"),
    ).toBeLessThanOrEqual(600);
    expect((sentPayload() as { message: string }).message).toHaveLength(4_000);
  });

  it("blanks amountRaw when truncating the message is not enough", async () => {
    seedDispatchTarget();
    const oversizedTip = { ...tip, message: "x".repeat(4_000) };

    await withMaxPayloadSize(400, async () => {
      await dispatchWebhooks(oversizedTip);
    });

    const stored = fake.deliveries[0]?.payload as {
      amountRaw: string;
      message: string;
    };
    expect(stored.message).toBe(`${"x".repeat(200)}…`);
    expect(stored.amountRaw).toBe("");
  });

  it("falls back to a minimal record when fixed fields still exceed the limit", async () => {
    seedDispatchTarget();
    const oversizedTip = { ...tip, message: "x".repeat(4_000) };

    await withMaxPayloadSize(10, async () => {
      await dispatchWebhooks(oversizedTip);
    });

    const stored = fake.deliveries[0]?.payload;
    expect(stored).toEqual({});
    expect(
      Buffer.byteLength(JSON.stringify(stored), "utf8"),
    ).toBeLessThanOrEqual(10);
  });

  it("bounds a test ping to a minimal record under a small configured limit", async () => {
    const webhookId = fake.seedWebhook({
      creatorId: CREATOR_ID,
      url: WEBHOOK_URL,
    }).id;

    await withMaxPayloadSize(10, async () => {
      await sendTestPing(CREATOR_ID, webhookId);
    });

    const stored = fake.deliveries[0]?.payload;
    expect(stored).toEqual({});
    expect(
      Buffer.byteLength(JSON.stringify(stored), "utf8"),
    ).toBeLessThanOrEqual(10);
    expect(sentPayload()).toMatchObject({ event: "webhook.test", test: true });
  });
});
