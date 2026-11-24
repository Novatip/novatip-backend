/**
 * webhooks/retention.ts
 *
 * Retention for WebhookDelivery and Notification logs.
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
import {
  createBatchPruner,
  cutoffFor,
  MAX_BATCHES_PER_RUN,
} from "../../utils/batch-pruner.js";

export { cutoffFor };

const retentionLogger = logger.child({ component: "webhook-retention" });

export interface PruneResult {
  deletedSuccesses: number;
  deletedFailures: number;
  deletedNotifications: number;
  /** True when the batch ceiling was hit with rows still outstanding. */
  truncated: boolean;
}

/** Whether any retention window is active. Both at 0 means keep everything. */
export function retentionEnabled(): boolean {
  const { successDays, failureDays } = config.webhooks.retention;
  return (
    successDays > 0 ||
    failureDays > 0 ||
    config.notifications.retentionDays > 0
  );
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
 * Delete notifications older than `cutoff` in bounded batches. Notifications
 * share the webhook batch size, but have their own run budget so a delivery
 * backlog cannot starve notification retention.
 */
async function pruneNotificationsOlderThan(
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
): Promise<{ deleted: number; done: boolean }> {
  let deleted = 0;

  for (let batchesUsed = 0; batchesUsed < maxBatches; batchesUsed += 1) {
    const rows = await db.notification.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });

    if (rows.length === 0) return { deleted, done: true };

    const { count } = await db.notification.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deleted += count;

    if (rows.length < batchSize) return { deleted, done: true };
  }

  return { deleted, done: false };
}

/**
 * Delete webhook deliveries for both success and failure classes.
 */
export async function pruneWebhookDeliveries(
  now: Date = new Date(),
): Promise<{ deletedSuccesses: number; deletedFailures: number; truncated: boolean }> {
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

/**
 * Run one retention pass. Safe to call directly (a manual backfill, a test)
 * as well as from the scheduler.
 */
export async function pruneRetainedRows(
  now: Date = new Date(),
): Promise<PruneResult> {
  const deliveries = await pruneWebhookDeliveries(now);
  let deletedNotifications = 0;
  let truncated = deliveries.truncated;

  const notificationDays = config.notifications.retentionDays;
  if (notificationDays > 0) {
    const result = await pruneNotificationsOlderThan(
      cutoffFor(notificationDays, now),
      config.webhooks.retention.batchSize,
      MAX_BATCHES_PER_RUN,
    );
    deletedNotifications = result.deleted;
    truncated = truncated || !result.done;
  }

  return {
    deletedSuccesses: deliveries.deletedSuccesses,
    deletedFailures: deliveries.deletedFailures,
    deletedNotifications,
    truncated,
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const pruner = createBatchPruner({
  logger: retentionLogger,
  name: "retention",
  description: "retained rows",
  retentionEnabled,
  disabledMessage:
    "retention disabled — webhook deliveries and notifications are kept indefinitely",
  getStartMetadata: () => {
    const { successDays, failureDays, intervalMinutes, batchSize } =
      config.webhooks.retention;
    return { successDays, failureDays, intervalMinutes, batchSize };
  },
  getIntervalMs: () => config.webhooks.retention.intervalMinutes * 60_000,
  runPrune: () => pruneRetainedRows(),
  getTotalDeleted: (result) =>
    result.deletedSuccesses +
    result.deletedFailures +
    result.deletedNotifications,
  getLogDetails: (result) => ({
    deletedSuccesses: result.deletedSuccesses,
    deletedFailures: result.deletedFailures,
    deletedNotifications: result.deletedNotifications,
    truncated: result.truncated,
  }),
});

/** Start the periodic prune. Safe to call once at server startup. */
export function startDeliveryPruner(): void {
  pruner.start();
}

/** Stop the periodic prune. Called from the server's shutdown path. */
export function stopDeliveryPruner(): void {
  pruner.stop();
}
