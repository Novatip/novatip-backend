import { cacheGet } from './redis';
import { redis } from './redis'; // or your Redis client module

describe('cacheGet', () => {
  const testKey = 'test-corrupt-entry';
  const fullKey = `cache:${testKey}`;

  afterEach(async () => {
    await redis.del(fullKey);
    jest.restoreAllMocks();
  });

  it('should return parsed data for a valid cache entry', async () => {
    const data = { id: 123, name: 'Alice' };
    await redis.set(fullKey, JSON.stringify(data));

    const result = await cacheGet<{ id: number; name: string }>(testKey);
    expect(result).toEqual(data);
  });

  it('should handle malformed JSON safely by logging, deleting the key, and returning null', async () => {
    // 1. Seed a corrupted JSON entry in Redis
    const corruptedValue = '{ "id": 123, "name": invalid_json ';
    await redis.set(fullKey, corruptedValue);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // 2. Call cacheGet — should NOT throw
    const result = await cacheGet(testKey);

    // 3. Verify acceptance criteria
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to parse cached JSON for key "${fullKey}"`),
      expect.any(Error)
    );

    // 4. Verify the corrupted key was evicted from Redis
    const remainingKey = await redis.get(fullKey);
    expect(remainingKey).toBeNull();
  });
});