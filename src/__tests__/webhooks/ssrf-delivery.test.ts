import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["WEBHOOK_ALLOW_PRIVATE_HOSTS"] = "false";

const dnsLookupMock = jest.fn(async () => []);
jest.unstable_mockModule("node:dns/promises", () => ({
  lookup: dnsLookupMock,
}));

const { createFakeDb } = await import("./fake-db.helper.js");
type Fake = ReturnType<typeof createFakeDb>;
const { config } = await import("../../config.js");

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

const { dispatchWebhooks } =
  await import("../../modules/webhooks/webhooks.service.js");

const CREATOR = "creator_empty_dns";
const tip = {
  jarId: "@empty-dns",
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
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([]);
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

it("does not make a delivery request when DNS resolves to no addresses", async () => {
  fake.seedCreator({ id: CREATOR, jarId: tip.jarId });
  const webhook = fake.seedWebhook({
    creatorId: CREATOR,
    url: "https://empty.example/hook",
  });

  await dispatchWebhooks(tip);

  expect(dnsLookupMock).toHaveBeenCalledWith("empty.example", {
    all: true,
    verbatim: true,
  });
  expect(fake.deliveries).toHaveLength(1);
  expect(fake.deliveries[0]).toMatchObject({
    webhookId: webhook.id,
    success: false,
    statusCode: null,
  });
  expect(mockFetch).not.toHaveBeenCalled();
});
