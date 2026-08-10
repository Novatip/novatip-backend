/**
 * __tests__/indexer/cursor.test.ts
 *
 * Covers the poll-loop cursor arithmetic. The regression under test: because
 * `fetchTipEvents` treats `startLedger` as inclusive, leaving the cursor on a
 * processed ledger made every poll re-handle the same events — re-firing
 * webhooks and emails once per poll until a newer tip arrived.
 */

import { planBatch, isSaturatedLedger } from "../../indexer/cursor.js";

interface FakeEvent {
  id: string;
  ledger: number;
}

const ev = (id: string, ledger: number): FakeEvent => ({ id, ledger });

/**
 * Replay the poll loop against a fixed set of on-chain events and record every
 * event that got handed to `handleEvent` — i.e. every webhook/email dispatch.
 */
function replayPolls(
  chain: FakeEvent[],
  polls: number,
  { limit = 200, startLedger = 1 } = {},
): string[] {
  const dispatched: string[] = [];
  let cursorLedger: number | null = null;

  for (let i = 0; i < polls; i++) {
    // Stand-in for fetchTipEvents: startLedger is inclusive, capped at `limit`.
    const batch = chain.filter((e) => e.ledger >= startLedger).slice(0, limit);
    if (batch.length === 0) continue;

    const plan = planBatch(batch, startLedger, limit);
    for (const e of plan.toProcess) dispatched.push(e.id);

    startLedger = plan.nextStartLedger;
    if (plan.cursorLedger !== null) cursorLedger = plan.cursorLedger;
  }

  // The stored cursor must always agree with where the loop resumes from.
  if (cursorLedger !== null) expect(cursorLedger + 1).toBeLessThanOrEqual(startLedger);
  return dispatched;
}

describe("planBatch", () => {
  it("leaves the cursor untouched for an empty batch", () => {
    expect(planBatch([], 42, 200)).toEqual({
      toProcess: [],
      nextStartLedger: 42,
      cursorLedger: null,
    });
  });

  it("advances past the highest ledger of a short batch", () => {
    const events = [ev("a", 10), ev("b", 12)];
    const plan = planBatch(events, 10, 200);

    expect(plan.toProcess).toEqual(events);
    expect(plan.nextStartLedger).toBe(13);
    expect(plan.cursorLedger).toBe(12);
  });

  it("advances past a single-ledger batch instead of re-fetching it", () => {
    const plan = planBatch([ev("a", 7), ev("b", 7)], 7, 200);

    expect(plan.toProcess).toHaveLength(2);
    expect(plan.nextStartLedger).toBe(8);
    expect(plan.cursorLedger).toBe(7);
  });

  it("does not depend on the order events arrive in", () => {
    const plan = planBatch([ev("c", 15), ev("a", 11), ev("b", 13)], 11, 200);

    expect(plan.nextStartLedger).toBe(16);
    expect(plan.cursorLedger).toBe(15);
  });

  it("keeps the cursor one behind the ledger the loop resumes from", () => {
    const plan = planBatch([ev("a", 30)], 30, 200);

    expect(plan.cursorLedger).toBe(plan.nextStartLedger - 1);
  });

  describe("when the batch is full and may be truncated mid-ledger", () => {
    const limit = 4;

    it("holds back the highest ledger and re-fetches it next poll", () => {
      const events = [ev("a", 5), ev("b", 5), ev("c", 6), ev("d", 6)];
      const plan = planBatch(events, 5, limit);

      // Ledger 6 might have a fifth event the RPC could not fit in the batch.
      expect(plan.toProcess.map((e) => e.id)).toEqual(["a", "b"]);
      expect(plan.nextStartLedger).toBe(6);
      expect(plan.cursorLedger).toBe(5);
    });

    it("never skips an event that shares a ledger with a handled one", () => {
      // Ledger 6 holds three events but only two fit in this batch.
      const chain = [ev("a", 5), ev("b", 5), ev("c", 6), ev("d", 6), ev("e", 6)];
      const dispatched = replayPolls(chain, 3, { limit, startLedger: 5 });

      expect(dispatched.sort()).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("still advances when a full batch sits entirely in one ledger", () => {
      // Holding this back would stall the loop forever, so it must move on.
      const events = [ev("a", 9), ev("b", 9), ev("c", 9), ev("d", 9)];
      const plan = planBatch(events, 9, limit);

      expect(plan.toProcess).toHaveLength(4);
      expect(plan.nextStartLedger).toBe(10);
    });
  });
});

describe("isSaturatedLedger", () => {
  it("flags a full batch confined to one ledger", () => {
    expect(isSaturatedLedger([ev("a", 3), ev("b", 3)], 2)).toBe(true);
  });

  it("ignores a full batch spanning several ledgers", () => {
    expect(isSaturatedLedger([ev("a", 3), ev("b", 4)], 2)).toBe(false);
  });

  it("ignores a short batch", () => {
    expect(isSaturatedLedger([ev("a", 3)], 200)).toBe(false);
  });
});

describe("consecutive polls", () => {
  it("dispatches each tip exactly once", () => {
    const chain = [ev("tip1", 100), ev("tip2", 100), ev("tip3", 104)];
    const dispatched = replayPolls(chain, 5, { startLedger: 100 });

    expect(dispatched).toEqual(["tip1", "tip2", "tip3"]);
  });

  it("does not re-dispatch while waiting for a newer tip", () => {
    // The bug: polls 2..10 re-handled the tip in the latest ledger every 6s.
    const chain = [ev("tip1", 100)];
    const dispatched = replayPolls(chain, 10, { startLedger: 100 });

    expect(dispatched).toEqual(["tip1"]);
  });

  it("does not re-dispatch tips that arrive between polls", () => {
    const chain = [ev("tip1", 100)];
    const first = replayPolls(chain, 3, { startLedger: 100 });
    expect(first).toEqual(["tip1"]);

    // A new tip lands two ledgers later; the earlier one must not fire again.
    chain.push(ev("tip2", 102));
    const second = replayPolls(chain, 3, { startLedger: 101 });
    expect(second).toEqual(["tip2"]);
  });

  it("resumes from the stored cursor without replaying it", () => {
    const chain = [ev("tip1", 100), ev("tip2", 101)];
    const plan = planBatch(chain, 100, 200);

    // Restart path in startIndexer(): savedCursor + 1.
    const resumed = replayPolls(chain, 2, { startLedger: plan.cursorLedger! + 1 });

    expect(resumed).toEqual([]);
  });
});
