import { afterAll, afterEach, describe, expect, it, jest } from "@jest/globals";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeIf = DATABASE_URL ? describe : describe.skip;

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["MAX_WEBHOOKS_PER_CREATOR"] = "3";
process.env["WEBHOOK_ENCRYPTION_KEY"] ??= "a".repeat(64);
process.env["WEBHOOK_ALLOW_PRIVATE_HOSTS"] = "true";
process.env["JWT_SECRET"] ??= "integration-test-secret-not-used-long-enough";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const { db: prisma, disconnectDb } = await import("../../db.js");
const { createWebhook, deleteWebhook, dispatchWebhooks } = await import(
  "../../modules/webhooks/webhooks.service.js"
);

describeIf("Webhook Postgres integration", () => {
  const creatorIds: string[] = [];
  let creatorSequence = 0;

  async function createCreator() {
    const suffix = `${Date.now()}-${++creatorSequence}`;
    const creator = await prisma.creator.create({
      data: {
        walletAddress: `GTEST${suffix}`,
        slug: `webhook-test-${suffix}`,
        jarId: `@webhook-test-${suffix}`,
      },
    });
    creatorIds.push(creator.id);
    return creator;
  }

  afterAll(async () => {
    await disconnectDb();
  });

  afterEach(async () => {
    for (const creatorId of creatorIds.splice(0)) {
      const webhooks = await prisma.webhook.findMany({
        where: { creatorId },
        select: { id: true },
      });
      await prisma.webhookDelivery.deleteMany({
        where: { webhookId: { in: webhooks.map(({ id }) => id) } },
      });
      await prisma.webhook.deleteMany({ where: { creatorId } });
      await prisma.creator.deleteMany({ where: { id: creatorId } });
    }
  });

  it("keeps concurrent registrations at the per-creator cap", async () => {
    const creator = await createCreator();
    await createWebhook(
      creator.id,
      "https://hooks.example.com/one",
      "s".repeat(24),
    );
    await createWebhook(
      creator.id,
      "https://hooks.example.com/two",
      "s".repeat(24),
    );

    const attempts = await Promise.allSettled([
      createWebhook(
        creator.id,
        "https://hooks.example.com/three",
        "s".repeat(24),
      ),
      createWebhook(
        creator.id,
        "https://hooks.example.com/four",
        "s".repeat(24),
      ),
    ]);

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(
      await prisma.webhook.count({ where: { creatorId: creator.id } }),
    ).toBe(3);
  });

  it("deletes delivery history and its webhook in one operation", async () => {
    const creator = await createCreator();
    const webhook = await createWebhook(
      creator.id,
      "https://hooks.example.com/delete-test",
      "s".repeat(24),
    );
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    } as Response);

    try {
      globalThis.fetch = fetchMock;
      await dispatchWebhooks({
        jarId: creator.jarId,
        from: `G${"A".repeat(55)}`,
        amount: 1n,
        message: "integration test",
        ledger: 1,
        timestamp: new Date().toISOString(),
        txHash: `integration-${Date.now()}-${creator.id}`,
      });

      expect(
        await prisma.webhookDelivery.count({
          where: { webhookId: webhook.id },
        }),
      ).toBe(1);
      await expect(deleteWebhook(creator.id, webhook.id)).resolves.toBe(true);

      expect(
        await prisma.webhookDelivery.count({
          where: { webhookId: webhook.id },
        }),
      ).toBe(0);
      expect(await prisma.webhook.count({ where: { id: webhook.id } })).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
