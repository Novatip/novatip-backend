/**
 * redis.test.ts
 *
 * Unit tests for cacheGet's corrupt-entry handling.
 *
 * ioredis is mocked with an in-memory store so this runs without a Redis
 * server: the behaviour under test is cacheGet's own error handling, not the
 * client's. config.ts validates required env vars at module load, so those are
 * set before the module graph is imported.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const store = new Map<string, string>();

const mockClient = {
  get: async (key: string): Promise<string | null> => store.get(key) ?? null,
  set: async (key: string, value: string): Promise<"OK"> => {
    store.set(key, value);
    return "OK";
  },
  del: async (key: string): Promise<number> => (store.delete(key) ? 1 : 0),
  on: () => undefined,
  quit: async (): Promise<"OK"> => "OK",
};

jest.unstable_mockModule("ioredis", () => ({
  Redis: function Redis() {
    return mockClient;
  },
  default: function Redis() {
    return mockClient;
  },
}));

const { cacheGet, cacheSet } = await import("../redis.js");

describe("cacheGet", () => {
  const testKey = "test-corrupt-entry";
  const fullKey = `cache:${testKey}`;

  beforeEach(() => store.clear());

  it("returns the parsed value for a valid entry", async () => {
    const data = { id: 123, name: "Alice" };
    await cacheSet(testKey, data, 60);

    await expect(cacheGet<typeof data>(testKey)).resolves.toEqual(data);
  });

  it("returns null on a miss", async () => {
    await expect(cacheGet("never-written")).resolves.toBeNull();
  });

  it("treats a corrupt entry as a miss rather than throwing", async () => {
    store.set(fullKey, '{ "id": 123, "name": invalid_json ');

    await expect(cacheGet(testKey)).resolves.toBeNull();
  });

  it("evicts a corrupt entry so the next read repopulates it", async () => {
    store.set(fullKey, "not json at all");

    await cacheGet(testKey);

    expect(store.has(fullKey)).toBe(false);
  });
});
