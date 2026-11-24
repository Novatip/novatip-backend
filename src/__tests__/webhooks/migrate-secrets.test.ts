import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["WEBHOOK_ENCRYPTION_KEY"] ??= "a".repeat(64);

const { createFakeDb } = await import("./fake-db.helper.js");
type Fake = ReturnType<typeof createFakeDb>;
const fake: Fake = createFakeDb();

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

const { migrateWebhookSecrets } =
  await import("../../modules/webhooks/webhooks.service.js");
const {
  decryptWebhookSecret,
  encryptWebhookSecret,
  parseWebhookEncryptionKey,
} = await import("../../modules/webhooks/secret-crypto.js");

const key = parseWebhookEncryptionKey(process.env["WEBHOOK_ENCRYPTION_KEY"]);
const db = fakeDbForMigration();

function fakeDbForMigration(): {
  webhook: {
    findMany: (args: {
      select: { id: true; secret: true };
    }) => Promise<Array<{ id: string; secret: string }>>;
    updateMany: (args: {
      where: { id: string; secret: string };
      data: { secret: string };
    }) => Promise<{ count: number }>;
  };
} {
  return fake.db as {
    webhook: {
      findMany: (args: {
        select: { id: true; secret: true };
      }) => Promise<Array<{ id: string; secret: string }>>;
      updateMany: (args: {
        where: { id: string; secret: string };
        data: { secret: string };
      }) => Promise<{ count: number }>;
    };
  };
}

beforeEach(() => {
  fake.webhooks.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("migrateWebhookSecrets", () => {
  it("migrates only legacy secrets, preserving decryptability and counting writes", async () => {
    const legacySecret = "legacy-secret-to-migrate";
    const legacy = fake.seedWebhook({ creatorId: "creator_legacy" });
    legacy.secret = legacySecret;

    const encryptedSecret = "already-encrypted-secret";
    const encrypted = fake.seedWebhook({
      creatorId: "creator_encrypted",
      secret: encryptedSecret,
    });
    const storedEncrypted = encrypted.secret;

    await expect(migrateWebhookSecrets()).resolves.toBe(1);

    expect(legacy.secret).not.toBe(legacySecret);
    expect(decryptWebhookSecret(legacy.secret, key)).toBe(legacySecret);
    expect(encrypted.secret).toBe(storedEncrypted);
    expect(decryptWebhookSecret(encrypted.secret, key)).toBe(encryptedSecret);
  });

  it("does not write or count when every secret is already encrypted", async () => {
    fake.seedWebhook({ creatorId: "creator_one" });
    fake.seedWebhook({ creatorId: "creator_two" });
    const updateManySpy = jest.spyOn(db.webhook, "updateMany");

    await expect(migrateWebhookSecrets()).resolves.toBe(0);

    expect(updateManySpy).not.toHaveBeenCalled();
    updateManySpy.mockRestore();
  });

  it("does not double-count or throw when a concurrent migration wins", async () => {
    const legacy = fake.seedWebhook({ creatorId: "creator_race" });
    const legacySecret = "legacy-secret-race";
    legacy.secret = legacySecret;

    const originalFindMany = db.webhook.findMany;
    db.webhook.findMany = async (args) => {
      const rows = await originalFindMany(args);
      legacy.secret = encryptWebhookSecret(legacySecret, key);
      return rows;
    };

    try {
      await expect(migrateWebhookSecrets()).resolves.toBe(0);
    } finally {
      db.webhook.findMany = originalFindMany;
    }

    expect(decryptWebhookSecret(legacy.secret, key)).toBe(legacySecret);
  });
});
