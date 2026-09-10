/**
 * webhooks/retention.ts
 *
 * Retention for the WebhookDelivery log.
 *
 * Every dispatch attempt writes a row carrying the request payload and up to
 * 1 KB of response body — one per tip, per enabled webhook, forever. Nothing
 * read it back after the fact, so the table only ever grew, quietly becoming
 * the largest in the database and driving storage and backup cost.
 *
 * Successes and failures age out on separate schedules: successes are the bulk
 * of the volume and the least interesting, failures are what anyone actually
 * opens the table to look at.
 *
 * Deletes run in bounded batches. A single `DELETE ... WHERE attemptedAt < ?`
 * over a first run's backlog would hold row locks across the whole range and
 * write one enormous transaction; batching keeps each statement short and
 * lets the work spread across runs.
 */

import { db } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const retentionLogger = logger.child({ component: "webhook-retention" });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Ceiling on batches per run, shared across both classes. A first run against
 * a years-old table has more to delete than one pass should attempt; stopping
 * early leaves the rest for the next tick rather than running a single
 * multi-hour transaction. At the default batch size this is 25k rows a run.
 */
const MAX_BATCHES_PER_RUN = 50;

/** Delay before the first prune, so it doesn't compete with server startup. */
const FIRST_RUN_DELAY_MS = 60_000;

export interface PruneResult {
  deletedSuccesses: number;
  deletedFailures: number;
  /** True when the batch ceiling was hit with rows still outstanding. */
  truncated: boolean;
}

/** The timestamp before which rows of a given age are eligible for deletion. */
export function cutoffFor(days: number, now: Date): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/** Whether any retention window is active. Both at 0 means keep everything. */
export function retentionEnabled(): boolean {
  const { successDays, failureDays } = config.webhooks.retention;
  return successDays > 0 || failureDays > 0;
}

/**
 * Delete one class of delivery rows older than `cutoff`, in batches.
 *
 * Rows are selected by id first and deleted by id rather than by re-stating
 * the predicate: the delete then touches a known, bounded set of rows even
 * while new deliveries are being written underneath it.
 */
async function pruneOlderThan(
  success: boolean,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
): Promise<{ deleted: number; batchesUsed: number; done: boolean }> {
  let deleted = 0;
  let batchesUsed = 0;

  while (batchesUsed < maxBatches) {
    const rows = await db.webhookDelivery.findMany({
      where: { success, attemptedAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });

    if (rows.length === 0) return { deleted, batchesUsed, done: true };

    const { count } = await db.webhookDelivery.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });

    deleted += count;
    batchesUsed += 1;

    // A short page means the predicate is exhausted.
    if (rows.length < batchSize) return { deleted, batchesUsed, done: true };
  }

  return { deleted, batchesUsed, done: false };
}

/**
 * Run one retention pass. Safe to call directly (a manual backfill, a test)
 * as well as from the scheduler.
 */
export async function pruneWebhookDeliveries(
  now: Date = new Date(),
): Promise<PruneResult> {
  const { successDays, failureDays, batchSize } = config.webhooks.retention;

  let budget = MAX_BATCHES_PER_RUN;
  let truncated = false;

  let deletedSuccesses = 0;
  let deletedFailures = 0;

  if (successDays > 0 && budget > 0) {
    const result = await pruneOlderThan(
      true,
      cutoffFor(successDays, now),
      batchSize,
      budget,
    );
    deletedSuccesses = result.deleted;
    budget -= result.batchesUsed;
    truncated = truncated || !result.done;
  }

  if (failureDays > 0 && budget > 0) {
    const result = await pruneOlderThan(
      false,
      cutoffFor(failureDays, now),
      batchSize,
      budget,
    );
    deletedFailures = result.deleted;
    budget -= result.batchesUsed;
    truncated = truncated || !result.done;
  }

  return { deletedSuccesses, deletedFailures, truncated };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let pruneTimer: NodeJS.Timeout | null = null;
let pruneActive = false;

/**
 * Start the periodic prune. Safe to call once at server startup.
 *
 * Each run reschedules itself on completion rather than firing on a fixed
 * interval, so a slow pass against a large backlog can never overlap the next.
 */
export function startDeliveryPruner(): void {
  if (pruneTimer !== null || pruneActive) return;

  if (!retentionEnabled()) {
    retentionLogger.info(
      "retention disabled — webhook deliveries are kept indefinitely",
    );
    return;
  }

  const { successDays, failureDays, intervalMinutes, batchSize } =
    config.webhooks.retention;

  retentionLogger.info(
    { successDays, failureDays, intervalMinutes, batchSize },
    "starting webhook delivery pruner",
  );

  pruneActive = true;
  scheduleNext(FIRST_RUN_DELAY_MS);
}

/** Stop the periodic prune. Called from the server's shutdown path. */
export function stopDeliveryPruner(): void {
  pruneActive = false;

  if (pruneTimer !== null) {
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }
}

function scheduleNext(delayMs: number): void {
  pruneTimer = setTimeout(() => {
    void runPrune();
  }, delayMs);

  // Housekeeping must never be the reason the process stays alive.
  pruneTimer.unref();
}

async function runPrune(): Promise<void> {
  if (!pruneActive) return;

  try {
    const result = await pruneWebhookDeliveries();
    const total = result.deletedSuccesses + result.deletedFailures;

    if (total > 0) {
      retentionLogger.info(
        {
          deletedSuccesses: result.deletedSuccesses,
          deletedFailures: result.deletedFailures,
          truncated: result.truncated,
        },
        result.truncated
          ? "pruned webhook deliveries — batch ceiling reached, continuing next run"
          : "pruned webhook deliveries",
      );
    }
  } catch (err) {
    // Retention is housekeeping: a failed pass is logged and retried on the
    // next tick, never allowed to take the server down.
    retentionLogger.error({ err }, "delivery prune failed");
  }

  if (pruneActive) {
    scheduleNext(config.webhooks.retention.intervalMinutes * 60_000);
  }
}
