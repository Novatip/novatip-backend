import { jest } from "@jest/globals";

const envKeys = [
  "DATABASE_URL",
  "JWT_SECRET",
  "TIP_SPLITTER_CONTRACT_ID",
  "INDEXER_START_LEDGER",
  "NOTIFICATION_RETENTION_DAYS",
  "EMAIL_MAX_PER_CREATOR_PER_HOUR",
  "WEBHOOK_TIMEOUT_MS",
  "WEBHOOK_DELIVERY_CONCURRENCY",
  "TIMEOUT_MS",
  "WEBHOOK_MAX_BODY_SIZE",
  "MAX_BODY_SIZE",
  "WEBHOOK_MAX_PAYLOAD_SIZE",
  "MAX_PAYLOAD_SIZE",
  "WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE",
  "WEBHOOK_DELIVERY_PRUNE_INTERVAL_MINUTES",
  "WEBHOOK_DELIVERY_RETENTION_DAYS",
  "WEBHOOK_DELIVERY_FAILURE_RETENTION_DAYS",
] as const;
const originalEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);

async function loadConfig(): Promise<
  (typeof import("../config.js"))["config"]
> {
  const modules: Array<typeof import("../config.js")> = [];
  await jest.isolateModulesAsync(async () => {
    modules.push(await import("../config.js"));
  });
  return modules[0]!.config;
}

beforeEach(() => {
  process.env["DATABASE_URL"] = "postgresql://user:pass@localhost:5432/test";
  process.env["JWT_SECRET"] = "test-secret-not-used-for-signing";
  process.env["TIP_SPLITTER_CONTRACT_ID"] = `C${"A".repeat(55)}`;
  delete process.env["INDEXER_START_LEDGER"];
  delete process.env["NOTIFICATION_RETENTION_DAYS"];
  delete process.env["EMAIL_MAX_PER_CREATOR_PER_HOUR"];
  delete process.env["WEBHOOK_TIMEOUT_MS"];
  delete process.env["WEBHOOK_DELIVERY_CONCURRENCY"];
  delete process.env["TIMEOUT_MS"];
  delete process.env["WEBHOOK_MAX_BODY_SIZE"];
  delete process.env["MAX_BODY_SIZE"];
  delete process.env["WEBHOOK_MAX_PAYLOAD_SIZE"];
  delete process.env["MAX_PAYLOAD_SIZE"];
  delete process.env["WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE"];
  delete process.env["WEBHOOK_DELIVERY_PRUNE_INTERVAL_MINUTES"];
  delete process.env["WEBHOOK_DELIVERY_RETENTION_DAYS"];
  delete process.env["WEBHOOK_DELIVERY_FAILURE_RETENTION_DAYS"];
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("config", () => {
  it("throws when a required environment variable is missing", async () => {
    delete process.env["DATABASE_URL"];

    await expect(loadConfig()).rejects.toThrow(
      "Missing required env var: DATABASE_URL",
    );
  });

  it("loads a present required environment variable", async () => {
    await expect(loadConfig()).resolves.toMatchObject({
      databaseUrl: "postgresql://user:pass@localhost:5432/test",
    });
  });

  it("uses the fallback for a blank integer environment variable", async () => {
    process.env["INDEXER_START_LEDGER"] = " ";

    await expect(loadConfig()).resolves.toMatchObject({
      stellar: { indexerStartLedger: 0 },
    });
  });

  it("names a non-numeric integer environment variable in the error", async () => {
    process.env["INDEXER_START_LEDGER"] = "not-a-number";

    await expect(loadConfig()).rejects.toThrow(
      "Env var INDEXER_START_LEDGER must be an integer",
    );
  });

  it("defaults notification retention to 90 days", async () => {
    await expect(loadConfig()).resolves.toMatchObject({
      notifications: { retentionDays: 90 },
    });
  });

  it("allows notification retention to be disabled with zero", async () => {
    process.env["NOTIFICATION_RETENTION_DAYS"] = "0";

    await expect(loadConfig()).resolves.toMatchObject({
      notifications: { retentionDays: 0 },
    });
  });

  it("defaults individual tip email cap to ten per creator per hour", async () => {
    await expect(loadConfig()).resolves.toMatchObject({
      notifications: { emailMaxPerCreatorPerHour: 10 },
    });
  });

  it("allows the email cap to be zero to send digests only", async () => {
    process.env["EMAIL_MAX_PER_CREATOR_PER_HOUR"] = "0";

    await expect(loadConfig()).resolves.toMatchObject({
      notifications: { emailMaxPerCreatorPerHour: 0 },
    });
  });
});

describe("config.webhooks", () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("reads timeoutMs, maxBodySize and maxPayloadSize from their prefixed names", async () => {
    process.env["WEBHOOK_TIMEOUT_MS"] = "7000";
    process.env["WEBHOOK_MAX_BODY_SIZE"] = "2048";
    process.env["WEBHOOK_MAX_PAYLOAD_SIZE"] = "4096";

    await expect(loadConfig()).resolves.toMatchObject({
      webhooks: {
        timeoutMs: 7000,
        maxBodySize: 2048,
        maxPayloadSize: 4096,
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("configures the global webhook delivery concurrency", async () => {
    process.env["WEBHOOK_DELIVERY_CONCURRENCY"] = "3";

    await expect(loadConfig()).resolves.toMatchObject({
      webhooks: { deliveryConcurrency: 3 },
    });
  });

  it("rejects a non-positive webhook delivery concurrency", async () => {
    process.env["WEBHOOK_DELIVERY_CONCURRENCY"] = "0";

    await expect(loadConfig()).rejects.toThrow(
      "Env var WEBHOOK_DELIVERY_CONCURRENCY must be >= 1",
    );
  });

  it("ignores the unprefixed name once the prefixed one is set", async () => {
    process.env["WEBHOOK_TIMEOUT_MS"] = "7000";
    process.env["TIMEOUT_MS"] = "60000";

    await expect(loadConfig()).resolves.toMatchObject({
      webhooks: { timeoutMs: 7000 },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the unprefixed name with a startup warning naming the replacement", async () => {
    process.env["TIMEOUT_MS"] = "60000";

    await expect(loadConfig()).resolves.toMatchObject({
      webhooks: { timeoutMs: 60000 },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TIMEOUT_MS"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("WEBHOOK_TIMEOUT_MS"),
    );
  });

  it("falls back to MAX_BODY_SIZE and MAX_PAYLOAD_SIZE the same way", async () => {
    process.env["MAX_BODY_SIZE"] = "4096";
    process.env["MAX_PAYLOAD_SIZE"] = "8192";

    await expect(loadConfig()).resolves.toMatchObject({
      webhooks: { maxBodySize: 4096, maxPayloadSize: 8192 },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("WEBHOOK_MAX_BODY_SIZE"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("WEBHOOK_MAX_PAYLOAD_SIZE"),
    );
  });

  it("uses the default when neither name is set", async () => {
    await expect(loadConfig()).resolves.toMatchObject({
      webhooks: {
        timeoutMs: 5_000,
        maxBodySize: 1_024,
        maxPayloadSize: 2_048,
        deliveryConcurrency: 10,
        retention: {
          successDays: 30,
          failureDays: 90,
          batchSize: 500,
          intervalMinutes: 60,
        },
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([0, -1])(
    "rejects non-positive intervalMinutes (%s)",
    async (interval) => {
      process.env["WEBHOOK_DELIVERY_PRUNE_INTERVAL_MINUTES"] = String(interval);

      await expect(loadConfig()).rejects.toThrow(
        "Env var WEBHOOK_DELIVERY_PRUNE_INTERVAL_MINUTES must be >= 1",
      );
    },
  );

  it.each([0, -1])("rejects non-positive batchSize (%s)", async (batchSize) => {
    process.env["WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE"] = String(batchSize);

    await expect(loadConfig()).rejects.toThrow(
      "Env var WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE must be >= 1",
    );
  });
});
