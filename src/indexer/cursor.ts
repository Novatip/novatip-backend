/**
 * indexer/cursor.ts
 *
 * Cursor arithmetic for the poll loop.
 *
 * `fetchTipEvents` treats `startLedger` as *inclusive*, so the loop must
 * advance past the last ledger it fully processed — otherwise every poll
 * re-fetches and re-handles the same events, re-firing webhooks and emails.
 *
 * The catch: a batch capped at `limit` may end part-way through a ledger, with
 * the rest of that ledger's events still unfetched. Advancing past it would
 * drop them. So a full batch holds back its highest ledger and re-fetches it
 * next poll; only a short batch (which proves the RPC had nothing more to give)
 * may advance past its highest ledger.
 *
 * Kept free of SDK imports so it stays unit-testable in isolation.
 */

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

  const maxLedger = events.reduce((max, e) => (e.ledger > max ? e.ledger : max), events[0]!.ledger);
  const minLedger = events.reduce((min, e) => (e.ledger < min ? e.ledger : min), events[0]!.ledger);

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
export function isSaturatedLedger<T extends LedgerBound>(events: T[], limit: number): boolean {
  return (
    events.length >= limit && events.every((e) => e.ledger === events[0]!.ledger)
  );
}
