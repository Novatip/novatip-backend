export interface RateLimitRedisCall {
  key: string;
  timeWindow: number;
  max: number;
}

interface Counter {
  count: number;
  expiresAt: number;
}

type RateLimitCallback = (
  error: Error | null,
  result?: [number, number, boolean],
) => void;

export function createRateLimitRedisMock() {
  // A single backing store models Redis shared by independently-built servers.
  const counters = new Map<string, Counter>();
  const calls: RateLimitRedisCall[] = [];
  let now = 0;

  const redis = {
    rateLimit(
      key: string,
      timeWindow: number,
      max: number,
      ban: number,
      _continueExceeding: boolean,
      callback: RateLimitCallback,
    ): void {
      calls.push({ key, timeWindow, max });

      let counter = counters.get(key);
      if (!counter || counter.expiresAt <= now) {
        counter = { count: 1, expiresAt: now + timeWindow };
        counters.set(key, counter);
      } else {
        counter.count += 1;
      }

      const ttl = counter.expiresAt - now;
      callback(null, [
        counter.count,
        ttl,
        ban !== -1 && counter.count - max > ban,
      ]);
    },
  };

  return {
    redis,
    calls,
    advanceBy(milliseconds: number): void {
      now += milliseconds;
    },
    clear(): void {
      counters.clear();
      calls.length = 0;
      now = 0;
    },
  };
}
