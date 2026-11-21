import { jest } from "@jest/globals";
import type { WebhookDestination } from "../../modules/webhooks/webhook-url.js";

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

const postWebhookMock = jest.fn<
  (
    url: string,
    init: RequestInit,
    destination?: WebhookDestination,
  ) => Promise<Response>
>();
jest.unstable_mockModule("../../modules/webhooks/webhook-request.js", () => ({
  postWebhook: postWebhookMock,
}));

process.env["WEBHOOK_ALLOW_PRIVATE_HOSTS"] = "false";
const { config } = await import("../../config.js");
const { dispatchWebhooks, sendTestPing } =
  await import("../../modules/webhooks/webhooks.service.js");

const CREATOR_ID = "creator-ssrf-test";
const PRIVATE_URL = "https://127.0.0.1/hook";
const PUBLIC_URL = "https://93.184.216.34/hook";
const tip = {
  jarId: "@ssrf-test",
  from: `G${"A".repeat(55)}`,
  amount: 25_000_000n,
  message: "Thanks",
  ledger: 1_234,
  timestamp: "2026-10-20T12:34:56.000Z",
  txHash: "a".repeat(64),
};

const mockFetch = jest.fn<typeof fetch>();
const realFetch = globalThis.fetch;

beforeEach(() => {
  fake = createFakeDb();
  config.webhooks.allowPrivateHosts = false;
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  postWebhookMock.mockReset();
  postWebhookMock.mockResolvedValue(new Response("ok", { status: 200 }));
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("SSRF guard in webhook delivery", () => {
  it("records a failed dispatch for a loopback URL without making a request", async () => {
    fake.seedCreator({ id: CREATOR_ID, jarId: tip.jarId });
    const webhook = fake.seedWebhook({
      creatorId: CREATOR_ID,
      url: PRIVATE_URL,
    });

    await dispatchWebhooks(tip);

    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]).toMatchObject({
      webhookId: webhook.id,
      success: false,
      statusCode: null,
    });
    expect(postWebhookMock).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("records a failed test ping for a loopback URL without making a request", async () => {
    const webhook = fake.seedWebhook({
      creatorId: CREATOR_ID,
      url: PRIVATE_URL,
    });

    await expect(sendTestPing(CREATOR_ID, webhook.id)).resolves.toMatchObject({
      success: false,
      statusCode: null,
    });

    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]).toMatchObject({
      webhookId: webhook.id,
      success: false,
      statusCode: null,
    });
    expect(postWebhookMock).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("dispatches a public literal using the validated address when the guard is enabled", async () => {
    fake.seedCreator({ id: CREATOR_ID, jarId: tip.jarId });
    const webhook = fake.seedWebhook({
      creatorId: CREATOR_ID,
      url: PUBLIC_URL,
    });

    await dispatchWebhooks(tip);

    expect(fake.deliveries[0]).toMatchObject({
      webhookId: webhook.id,
      success: true,
      statusCode: 200,
    });
    expect(postWebhookMock).toHaveBeenCalledTimes(1);
    expect(postWebhookMock.mock.calls[0]?.[2]).toEqual({
      address: "93.184.216.34",
      family: 4,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
