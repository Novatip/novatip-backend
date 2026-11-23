/**
 * __tests__/webhooks/rotation-race.test.ts
 *
 * Deliveries sign with the webhook's secret as of send time, not enqueue
 * time: rotating while a delivery is queued must not produce a signature made
 * with the old secret. Covers both the tip dispatch path and the test ping,
 * which share the delivery queue.
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

const { config } = await import("../../config.js");
const { dispatchWebhooks, sendTestPing, rotateWebhookSecret } =
  await import("../../modules/webhooks/webhooks.service.js");

const CREATOR = "creator_race";
const OLD_SECRET = "old-secret-at-least-16-chars";
const NEW_SECRET = "new-secret-at-least-16-chars";

const mockFetch = jest.fn<typeof fetch>();
const realFetch = globalThis.fetch;
const pending: Array<(response: Response) => void> = [];

beforeEach(() => {
  fake = createFakeDb();
  pending.length = 0;
  mockFetch.mockReset();
  mockFetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        pending.push(resolve);
      }),
  );
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function expectedSignature(call: number, secret: string): string {
  const init = mockFetch.mock.calls[call]![1]!;
  const headers = init.headers as Record<string, string>;
  const timestamp = headers["X-Novatip-Timestamp"]!;
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${String(init.body)}`)
    .digest("hex");
  return `sha256=${digest}`;
}

function sentSignature(call: number): string | undefined {
  const headers = mockFetch.mock.calls[call]![1]!.headers as Record<
    string,
    string
  >;
  return headers["X-Novatip-Signature"];
}

async function withConcurrencyOne(fn: () => Promise<void>): Promise<void> {
  const webhookConfig = config.webhooks as { deliveryConcurrency: number };
  const original = webhookConfig.deliveryConcurrency;
  webhookConfig.deliveryConcurrency = 1;
  try {
    await fn();
  } finally {
    webhookConfig.deliveryConcurrency = original;
  }
}

describe("secret rotation while a delivery is queued", () => {
  it("signs a queued tip delivery with the rotated secret", async () => {
    await withConcurrencyOne(async () => {
      const creator = fake.seedCreator({ id: CREATOR });
      // Two webhooks: the first occupies the single slot, so the second
      // stays queued while its secret is rotated.
      fake.seedWebhook({ creatorId: CREATOR, secret: OLD_SECRET });
      const queued = fake.seedWebhook({
        creatorId: CREATOR,
        url: "https://hooks2.example.com/novatip",
        secret: OLD_SECRET,
      });

      const dispatch = dispatchWebhooks({
        jarId: creator.jarId,
        from: "GSENDER",
        amount: 10_000_000n,
        message: "hi",
        ledger: 1,
        timestamp: "2026-11-23T00:00:00.000Z",
        txHash: "hash_race",
      } as Parameters<typeof dispatchWebhooks>[0]);

      await tick();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await rotateWebhookSecret(CREATOR, queued.id, NEW_SECRET);

      pending.shift()!(new Response("ok", { status: 200 }));
      await tick();
      await tick();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      pending.shift()!(new Response("ok", { status: 200 }));
      await dispatch;

      expect(sentSignature(1)).toBe(expectedSignature(1, NEW_SECRET));
      expect(sentSignature(1)).not.toBe(expectedSignature(1, OLD_SECRET));
    });
  });

  it("signs a queued test ping with the rotated secret", async () => {
    await withConcurrencyOne(async () => {
      fake.seedCreator({ id: CREATOR });
      const first = fake.seedWebhook({ creatorId: CREATOR, secret: OLD_SECRET });
      const second = fake.seedWebhook({
        creatorId: CREATOR,
        url: "https://hooks2.example.com/novatip",
        secret: OLD_SECRET,
      });

      const blocker = sendTestPing(CREATOR, first.id);
      await tick();
      const queued = sendTestPing(CREATOR, second.id);
      await tick();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await rotateWebhookSecret(CREATOR, second.id, NEW_SECRET);

      pending.shift()!(new Response("ok", { status: 200 }));
      await blocker;
      await tick();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      pending.shift()!(new Response("ok", { status: 200 }));
      await queued;

      expect(sentSignature(1)).toBe(expectedSignature(1, NEW_SECRET));
    });
  });
});
