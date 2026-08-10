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
