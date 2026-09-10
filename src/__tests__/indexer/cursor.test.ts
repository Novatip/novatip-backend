/**
 * __tests__/indexer/cursor.test.ts
 *
 * Covers the idle cursor policy. The regression under test: the cursor only
 * moved when a batch contained a tip, so a quiet stretch left it pinned to the
 * last ledger that had one and every restart re-scanned from there.
 */

import {
  IDLE_CHECK_INTERVAL_MS,
  isIdleCheckDue,
  planIdleAdvance,
} from "../../indexer/cursor.js";

const POLL_INTERVAL_MS = 6_000;
/** Stellar closes a ledger roughly every 5s. */
const LEDGER_CLOSE_MS = 5_000;

interface CursorWrite {
  atMs: number;
  ledger: number;
}

interface ReplayResult {
  writes: CursorWrite[];
  startLedger: number;
  persistedCursor: number;
}

/**
 * Replay the poll loop through a stretch with no tip activity, recording every
 * cursor write. Mirrors startIndexer(): read head when the idle check is due,
 * fetch (empty), then advance.
 */
function replayIdlePolls(opts: {
  polls: number;
  startLedger: number;
  savedCursor: number;
  headAtStart: number;
}): ReplayResult {
  const writes: CursorWrite[] = [];
  let now = 0;
  let lastIdleCheckAt: number | null = null;
  let startLedger = opts.startLedger;
  let persistedCursor = opts.savedCursor;

  for (let i = 0; i < opts.polls; i++) {
    let observedHead: number | null = null;

    if (isIdleCheckDue(now, lastIdleCheckAt)) {
      lastIdleCheckAt = now;
      observedHead = opts.headAtStart + Math.floor(now / LEDGER_CLOSE_MS);
    }

    // Batch comes back empty — the quiet period this issue is about.
    const advance = planIdleAdvance(observedHead, startLedger, persistedCursor);

    if (advance) {
      writes.push({ atMs: now, ledger: advance.cursorLedger });
      startLedger = advance.nextStartLedger;
      persistedCursor = advance.cursorLedger;
    }

    now += POLL_INTERVAL_MS;
  }

  return { writes, startLedger, persistedCursor };
}

describe("isIdleCheckDue", () => {
  it("is due on the first poll", () => {
    expect(isIdleCheckDue(0, null)).toBe(true);
  });

  it("is not due again within the interval", () => {
    expect(isIdleCheckDue(1_000 + POLL_INTERVAL_MS, 1_000)).toBe(false);
  });

  it("is due once the interval has elapsed", () => {
    expect(isIdleCheckDue(1_000 + IDLE_CHECK_INTERVAL_MS, 1_000)).toBe(true);
  });

  it("accepts an interval override", () => {
    expect(isIdleCheckDue(500, 0, 1_000)).toBe(false);
    expect(isIdleCheckDue(1_000, 0, 1_000)).toBe(true);
  });
});

describe("planIdleAdvance", () => {
  it("advances past the observed head", () => {
    expect(planIdleAdvance(900, 700, 699)).toEqual({
      nextStartLedger: 901,
      cursorLedger: 900,
    });
  });

  it("does nothing when head was not read this poll", () => {
    expect(planIdleAdvance(null, 700, 699)).toBeNull();
  });

  it("never moves the cursor backwards", () => {
    // INDEXER_START_LEDGER set ahead of the chain.
    expect(planIdleAdvance(500, 900, 0)).toBeNull();
  });

  it("does not rewrite a cursor that is already at head", () => {
    expect(planIdleAdvance(900, 901, 900)).toBeNull();
  });

  it("keeps the cursor one behind the ledger the loop resumes from", () => {
    const advance = planIdleAdvance(900, 700, 0)!;

    expect(advance.cursorLedger).toBe(advance.nextStartLedger - 1);
  });

  it("advances from a fresh install with no saved cursor", () => {
    expect(planIdleAdvance(1_000, 1, 0)).toEqual({
      nextStartLedger: 1_001,
      cursorLedger: 1_000,
    });
  });
});

describe("an idle indexer", () => {
  const oneHourOfPolls = (60 * 60 * 1_000) / POLL_INTERVAL_MS;

  it("advances the cursor even though no tips arrive", () => {
    const { persistedCursor } = replayIdlePolls({
      polls: oneHourOfPolls,
      startLedger: 1_001,
      savedCursor: 1_000,
      headAtStart: 1_000,
    });

    // An hour of ledgers closed; the cursor tracked them rather than staying
    // pinned at 1000.
    expect(persistedCursor).toBeGreaterThan(
      1_000 + (60 * 60 * 1_000) / LEDGER_CLOSE_MS - 20,
    );
  });

  it("throttles writes to at most one per interval", () => {
    const { writes } = replayIdlePolls({
      polls: oneHourOfPolls,
      startLedger: 1_001,
      savedCursor: 1_000,
      headAtStart: 1_000,
    });

    // 600 polls in the hour — without throttling that is 600 writes.
    expect(writes.length).toBeLessThanOrEqual(
      3_600_000 / IDLE_CHECK_INTERVAL_MS + 1,
    );

    for (let i = 1; i < writes.length; i++) {
      expect(writes[i]!.atMs - writes[i - 1]!.atMs).toBeGreaterThanOrEqual(
        IDLE_CHECK_INTERVAL_MS,
      );
    }
  });

  it("resumes near chain head after a restart instead of re-scanning", () => {
    const headAtStart = 1_000;
    const idleDays = 7;
    const polls = (idleDays * 24 * 60 * 60 * 1_000) / POLL_INTERVAL_MS;

    const { persistedCursor } = replayIdlePolls({
      polls,
      startLedger: headAtStart + 1,
      savedCursor: headAtStart,
      headAtStart,
    });

    // Restart path in startIndexer(): savedCursor + 1.
    const resumeLedger = persistedCursor + 1;
    const headNow =
      headAtStart + (idleDays * 24 * 60 * 60 * 1_000) / LEDGER_CLOSE_MS;

    // Before the fix this was headAtStart + 1 — a week of ledgers to re-scan,
    // most of which have long since aged out of RPC event retention.
    expect(headNow - resumeLedger).toBeLessThan(
      IDLE_CHECK_INTERVAL_MS / LEDGER_CLOSE_MS + 1,
    );
  });

  it("does not write the cursor when the chain head has not moved", () => {
    // Head frozen: planIdleAdvance must stop rewriting the same value.
    let writes = 0;
    let persistedCursor = 1_000;
    let startLedger = 1_001;

    for (let i = 0; i < 10; i++) {
      const advance = planIdleAdvance(1_005, startLedger, persistedCursor);
      if (advance) {
        writes++;
        startLedger = advance.nextStartLedger;
        persistedCursor = advance.cursorLedger;
      }
    }

    expect(writes).toBe(1);
  });
});
