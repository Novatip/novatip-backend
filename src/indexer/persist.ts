/**
 * indexer/persist.ts
 *
 * Persists a decoded TipEvent to PostgreSQL and updates the indexer cursor.
 * Called by the indexer loop after each confirmed event batch.
 */

import type { TipEvent } from "@novatip/sdk";
import { db } from "../db.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const persistLogger = logger.child({ component: "indexer:persist" });

/**
 * The IndexerCursor table holds exactly one row by design to track the
 * indexer's progress across restarts.
 */
export const INDEXER_CURSOR_ID = 1;

/**
 * Persist a single TipEvent.
 * Uses upsert on txHash so re-runs are idempotent.
 * Returns true when the tip was newly created, false when it already existed.
 *
 * @param event     - Decoded TipEvent from the SDK event parser
 * @param txHash    - Soroban transaction hash (used as idempotency key)
 */
export async function persistTip(
  event: TipEvent,
  txHash: string,
): Promise<boolean> {
  const creator = await db.creator.findUnique({
    where: { jarId: event.jarId },
  });

  const { count } = await db.tip.createMany({
    data: [
      {
        txHash,
        ledger: event.ledger,
        ledgerAt: new Date(event.timestamp),
        fromAddress: event.from,
        amount: event.amount.toString(),
        message: event.message,
        jarId: event.jarId,
        creatorId: creator?.id ?? null,
      },
    ],
    skipDuplicates: true,
  });

  if (!creator) {
    persistLogger.info(
      { jarId: event.jarId },
      "Tip received for unclaimed jar; stored without owner (tip will be attached when jar is claimed)",
    );
  }

  return count > 0;
}

/**
 * Update the indexer cursor to the last processed ledger.
 * Uses upsert on the single-row IndexerCursor table (id = 1).
 */
export async function updateCursor(ledger: number): Promise<void> {
  await db.indexerCursor.upsert({
    where: { id: INDEXER_CURSOR_ID },
    update: { lastLedger: ledger },
    create: { id: INDEXER_CURSOR_ID, lastLedger: ledger },
  });
}

/**
 * Read the last processed ledger from the cursor table.
 * Returns 0 if the cursor has never been set.
 */
export async function readCursor(): Promise<number> {
  const cursor = await db.indexerCursor.findUnique({
    where: { id: INDEXER_CURSOR_ID },
  });
  return cursor?.lastLedger ?? 0;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 50;
const FIRST_RUN_DELAY_MS = 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60_000;

/**
 * Prune unowned tips older than the configured number of days in bounded
 * batches, consistent with webhooks/retention.ts so a large backlog does not
 * hold row locks across the whole cutoff range in a single transaction.
 * Tips with no creatorId may belong to another application, so they are not
 * kept indefinitely.
 */
export async function pruneUnownedTips(
  olderThanDays: number,
  batchSize: number = DEFAULT_PRUNE_BATCH_SIZE,
  maxBatches: number = MAX_BATCHES_PER_RUN,
): Promise<number> {
  if (olderThanDays <= 0) return 0;

  const cutoff = new Date(Date.now() - olderThanDays * MS_PER_DAY);
  let deleted = 0;

  for (let batchesUsed = 0; batchesUsed < maxBatches; batchesUsed += 1) {
    const rows = await db.tip.findMany({
      where: {
        creatorId: null,
        ledgerAt: { lt: cutoff },
      },
      select: { id: true },
      take: batchSize,
    });

    if (rows.length === 0) break;

    const { count } = await db.tip.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deleted += count;

    if (rows.length < batchSize) break;
  }

  return deleted;
}

// ── Unowned tip pruner scheduler ──────────────────────────────────────────────

export interface UnownedTipPrunerOptions {
  firstRunDelayMs?: number;
  intervalMs?: number;
  batchSize?: number;
  maxBatches?: number;
}

let pruneTimer: NodeJS.Timeout | null = null;
let pruneActive = false;

/**
 * Start the periodic unowned tip prune. Safe to call once at server startup.
 *
 * Each run reschedules itself on completion rather than firing on a fixed
 * interval, so a slow pass against a large backlog can never overlap the next.
 */
export function startUnownedTipPruner(options?: UnownedTipPrunerOptions): void {
  if (pruneTimer !== null || pruneActive) return;

  const retentionDays = config.indexer.unownedTipRetentionDays;
  if (retentionDays <= 0) {
    persistLogger.info(
      "unowned tip retention disabled — unowned tips are kept indefinitely",
    );
    return;
  }

  persistLogger.info(
    { unownedTipRetentionDays: retentionDays },
    "starting unowned tip pruner",
  );

  pruneActive = true;
  scheduleNextPrune(options?.firstRunDelayMs ?? FIRST_RUN_DELAY_MS, options);
}

/** Stop the periodic unowned tip prune. Called from the server's shutdown path. */
export function stopUnownedTipPruner(): void {
  pruneActive = false;

  if (pruneTimer !== null) {
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }
}

function scheduleNextPrune(
  delayMs: number,
  options?: UnownedTipPrunerOptions,
): void {
  pruneTimer = setTimeout(() => {
    void runUnownedTipPrune(options);
  }, delayMs);

  // Housekeeping must never be the reason the process stays alive.
  pruneTimer.unref();
}

async function runUnownedTipPrune(
  options?: UnownedTipPrunerOptions,
): Promise<void> {
  if (!pruneActive) return;

  try {
    const deleted = await pruneUnownedTips(
      config.indexer.unownedTipRetentionDays,
      options?.batchSize,
      options?.maxBatches,
    );

    if (deleted > 0) {
      persistLogger.info({ deleted }, "pruned unowned tips");
    }
  } catch (err) {
    // Retention is housekeeping: a failed pass is logged and retried on the
    // next tick, never allowed to take the server down.
    persistLogger.error({ err }, "unowned tip prune failed");
  }

  if (pruneActive) {
    scheduleNextPrune(options?.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS, options);
  }
}
