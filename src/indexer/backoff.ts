/**
 * indexer/backoff.ts
 *
 * Escalating backoff policy for indexer poll errors.
 * Kept as pure functions free of I/O or state so that backoff calculations
 * are deterministic and fully unit-testable.
 */

/**
 * Default base backoff delay in milliseconds for the first failure (12 seconds,
 * matching the default 6,000 ms poll interval * 2). Callers such as `runLoop`
 * pass `pollIntervalMs * 2` as `baseMs` so the backoff tracks the configured
 * poll cadence; this constant is used only when `baseMs` is omitted.
 */
export const BASE_POLL_BACKOFF_MS = 12_000;

/**
 * Documented ceiling for backoff delays in milliseconds (60 seconds / 1 minute).
 * Prevents poll errors during extended RPC outages or rate limits from backing
 * off indefinitely, while bounding retry frequency to avoid log spam and keeping
 * provider rate limits engaged.
 */
export const MAX_POLL_BACKOFF_MS = 60_000;

/**
 * Calculate the backoff sleep duration in milliseconds based on consecutive failures.
 *
 * Escalates exponentially with consecutive failures (`baseMs * 2^(consecutiveFailures - 1)`),
 * capped at `maxMs`. When `baseMs` is omitted it defaults to `BASE_POLL_BACKOFF_MS`
 * (12,000 ms); `runLoop` passes `pollIntervalMs * 2` so the backoff schedule
 * scales proportionally with the configured poll interval:
 * - 1 failure:  baseMs (12,000 ms at the default 6,000 ms poll interval)
 * - 2 failures: baseMs * 2 (24,000 ms)
 * - 3 failures: baseMs * 4 (48,000 ms)
 * - 4+ failures: capped at MAX_POLL_BACKOFF_MS (60,000 ms)
 *
 * @param consecutiveFailures - Total consecutive poll errors encountered (>= 1)
 * @param baseMs - Base backoff duration (defaults to BASE_POLL_BACKOFF_MS; `runLoop` passes `pollIntervalMs * 2`)
 * @param maxMs - Upper backoff ceiling (defaults to MAX_POLL_BACKOFF_MS)
 * @returns Delay in milliseconds to sleep before retrying
 */
export function calculatePollBackoff(
  consecutiveFailures: number,
  baseMs: number = BASE_POLL_BACKOFF_MS,
  maxMs: number = MAX_POLL_BACKOFF_MS,
): number {
  if (consecutiveFailures <= 0) return 0;
  const factor = Math.pow(2, consecutiveFailures - 1);
  const delay = baseMs * factor;
  return Math.min(delay, maxMs);
}
