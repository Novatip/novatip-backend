/**
 * indexer/cursor.ts
 *
 * Cursor policy for the poll loop, kept pure and free of SDK/DB imports so it
 * stays unit-testable.
 *
 * The problem it solves: the cursor used to move only when a batch contained a
 * tip, so during a quiet stretch it stayed pinned to the last ledger that had
 * one. A restart then re-scanned every ledger since — a growing backfill on
 * each deploy, and eventually a fetch that fails outright once the cursor falls
 * outside the RPC's event-retention window.
 *
 * An empty batch is itself information: it proves no tip events exist between
 * the cursor and chain head, so the cursor can safely jump to the head. Those
 * writes are throttled — an idle indexer polls every 6s but must not write to
 * Postgres that often.
 */

/** How often the loop may read chain head and persist the cursor while idle. */
export const IDLE_CHECK_INTERVAL_MS = 60_000;

export interface IdleAdvance {
  /** Inclusive ledger the next `fetchTipEvents` call should start from. */
  nextStartLedger: number;
  /** Ledger to persist as the last one scanned in full. */
  cursorLedger: number;
}

/**
 * Whether enough time has passed to run the idle check again.
 *
 * Gates both the chain-head read and the cursor write that may follow, so the
 * 6s poll cadence costs neither an extra RPC round trip nor a Postgres write.
 *
 * @param nowMs         - Current wall-clock time
 * @param lastCheckAtMs - When the idle check last ran, or null if never
 */
export function isIdleCheckDue(
  nowMs: number,
  lastCheckAtMs: number | null,
  intervalMs: number = IDLE_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckAtMs === null) return true;
  return nowMs - lastCheckAtMs >= intervalMs;
}

/**
 * Decide where the cursor lands after a batch that contained no events.
 *
 * `observedHead` must be read *before* the event fetch: the fetch then covers
 * at least everything up to that head, so an empty result proves those ledgers
 * hold no tips. Reading it afterwards could skip a tip that landed in between.
 *
 * Returns null when there is nothing worth writing — head not read this poll,
 * head behind the cursor (a start ledger set in the future), or no new ledgers
 * since the last write.
 *
 * @param observedHead    - Chain head read before the fetch, or null if not read
 * @param startLedger     - Inclusive ledger the empty batch was fetched from
 * @param persistedCursor - Last ledger written to IndexerCursor
 */
export function planIdleAdvance(
  observedHead: number | null,
  startLedger: number,
  persistedCursor: number,
): IdleAdvance | null {
  if (observedHead === null) return null;

  // Never move backwards, and never rewrite the same value.
  if (observedHead < startLedger) return null;
  if (observedHead <= persistedCursor) return null;

  return { nextStartLedger: observedHead + 1, cursorLedger: observedHead };
}

// ── Batch planning ────────────────────────────────────────────────────────────

/** Minimal shape this module needs from a decoded event. */
export interface LedgerBound {
  ledger: number;
}

export interface BatchPlan<T extends LedgerBound> {
  /** Events safe to handle now — the rest are re-fetched on the next poll. */
  toProcess: T[];
  /** Inclusive ledger to pass to the next `fetchTipEvents` call. */
  nextStartLedger: number;
  /** Highest fully-processed ledger, or null when nothing was processed. */
  cursorLedger: number | null;
}

/**
 * Decide which events of a batch to process and where the cursor lands.
 *
 * @param events      - Events returned by `fetchTipEvents`, any order
 * @param startLedger - The inclusive ledger the batch was fetched from
 * @param limit       - The `limit` the batch was fetched with
 */
export function planBatch<T extends LedgerBound>(
  events: T[],
  startLedger: number,
  limit: number,
): BatchPlan<T> {
  if (events.length === 0) {
    return { toProcess: [], nextStartLedger: startLedger, cursorLedger: null };
  }

  const maxLedger = events.reduce(
    (max, e) => (e.ledger > max ? e.ledger : max),
    events[0]!.ledger,
  );
  const minLedger = events.reduce(
    (min, e) => (e.ledger < min ? e.ledger : min),
    events[0]!.ledger,
  );

  // Short batch: the RPC returned everything it had, so `maxLedger` is complete
  // and the loop can move past it.
  if (events.length < limit) {
    return {
      toProcess: events,
      nextStartLedger: maxLedger + 1,
      cursorLedger: maxLedger,
    };
  }

  // Full batch spanning several ledgers: `maxLedger` may be truncated, so hold
  // its events back and re-fetch that ledger in full next poll.
  if (maxLedger > minLedger) {
    return {
      toProcess: events.filter((e) => e.ledger < maxLedger),
      nextStartLedger: maxLedger,
      cursorLedger: maxLedger - 1,
    };
  }

  // Full batch confined to a single ledger: holding it back would stall the
  // loop forever, so process it and move on. Anything beyond `limit` events in
  // one ledger is unreachable without RPC paging.
  return {
    toProcess: events,
    nextStartLedger: maxLedger + 1,
    cursorLedger: maxLedger,
  };
}

/** True when `planBatch` had to give up on paging within a single ledger. */
export function isSaturatedLedger<T extends LedgerBound>(
  events: T[],
  limit: number,
): boolean {
  return (
    events.length >= limit &&
    events.every((e) => e.ledger === events[0]!.ledger)
  );
}
