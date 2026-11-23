/**
 * creator/placeholder-retention.ts
 *
 * Retention for abandoned placeholder creator accounts.
 *
 * When a user signs in via wallet, a placeholder Creator row is generated
 * with an auto-assigned slug (`user_<hex>`). If they never claim a custom
 * slug or receive tips, the account remains inert. Over time, these abandoned
 * placeholders accumulate and consume storage.
 *
 * This pruner periodically removes un-customized placeholder creators whose
 * `createdAt` is older than the configured retention window.
 *
 * Active creators are protected: the query checks for zero associated tips,
 * webhooks, notifications, and released slugs. A creator who started sign-in
 * and then claimed a real slug in a later transaction is also protected
 * because their slug no longer matches the placeholder pattern.
 *
 * Deletes run in bounded batches. A single unconstrained DELETE across a
 * large backlog would hold row locks and generate a massive transaction;
 * batching keeps individual statements short and spreads the work across runs.
 */

import { db } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  PLACEHOLDER_SLUG_PREFIX,
  PLACEHOLDER_SLUG_REGEX,
} from "./creator.service.js";
import {
  createBatchPruner,
  cutoffFor,
  MAX_BATCHES_PER_RUN,
} from "../../utils/batch-pruner.js";

export { cutoffFor };

const retentionLogger = logger.child({ component: "placeholder-retention" });

export interface PlaceholderPruneResult {
  deleted: number;
  /** True when the batch ceiling was hit with rows still outstanding. */
  truncated: boolean;
}

/** Whether the retention window is active. 0 means keep everything. */
export function retentionEnabled(): boolean {
  return config.creators.placeholderRetentionDays > 0;
}

/**
 * Predicate identifying a creator row with no child records in any dependent
 * table. Expressed through Prisma relation filters so PostgreSQL executes the
 * existence checks in the same query; an interactive transaction is not
 * required because a new row between the two naturally drops that creator out of
 * the delete rather than racing a foreign-key error.
 */
const isInert = {
  tips: { none: {} },
  webhooks: { none: {} },
  notifications: { none: {} },
  releasedSlugs: { none: {} },
} as const;

/**
 * Delete one batch of eligible placeholders, cursoring forward by id so a
 * page of near-misses (slug starts with "user_" but isn't the exact
 * placeholder pattern — see PLACEHOLDER_SLUG_REGEX) can never stall the loop
 * on the same unselectable rows.
 */
async function pruneBatch(
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
): Promise<{ deleted: number; batchesUsed: number; done: boolean }> {
  let deleted = 0;
  let batchesUsed = 0;
  let cursor: string | undefined;

  while (batchesUsed < maxBatches) {
    const candidates = await db.creator.findMany({
      where: {
        slug: { startsWith: PLACEHOLDER_SLUG_PREFIX },
        createdAt: { lt: cutoff },
        ...isInert,
      },
      select: { id: true, slug: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor !== undefined && { cursor: { id: cursor }, skip: 1 }),
    });

    if (candidates.length === 0) return { deleted, batchesUsed, done: true };

    const eligibleIds = candidates
      .filter((candidate) => PLACEHOLDER_SLUG_REGEX.test(candidate.slug))
      .map((candidate) => candidate.id);

    if (eligibleIds.length > 0) {
      const { count } = await db.creator.deleteMany({
        where: { id: { in: eligibleIds }, ...isInert },
      });
      deleted += count;
    }

    cursor = candidates[candidates.length - 1]!.id;
    batchesUsed += 1;

    if (candidates.length < batchSize) {
      return { deleted, batchesUsed, done: true };
    }
  }

  return { deleted, batchesUsed, done: false };
}

/**
 * Run one retention pass. Safe to call directly (a manual backfill, a test)
 * as well as from the scheduler.
 */
export async function prunePlaceholderCreators(
  now: Date = new Date(),
): Promise<PlaceholderPruneResult> {
  if (!retentionEnabled()) return { deleted: 0, truncated: false };

  const { placeholderRetentionDays, placeholderPruneBatchSize } =
    config.creators;

  const result = await pruneBatch(
    cutoffFor(placeholderRetentionDays, now),
    placeholderPruneBatchSize,
    MAX_BATCHES_PER_RUN,
  );

  return { deleted: result.deleted, truncated: !result.done };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const pruner = createBatchPruner({
  logger: retentionLogger,
  name: "placeholder creator",
  description: "placeholder creators",
  retentionEnabled,
  disabledMessage:
    "retention disabled — abandoned sign-in placeholders are kept indefinitely",
  getStartMetadata: () => {
    const {
      placeholderRetentionDays,
      placeholderPruneBatchSize,
      placeholderPruneIntervalMinutes,
    } = config.creators;
    return {
      placeholderRetentionDays,
      placeholderPruneBatchSize,
      placeholderPruneIntervalMinutes,
    };
  },
  getIntervalMs: () => config.creators.placeholderPruneIntervalMinutes * 60_000,
  runPrune: () => prunePlaceholderCreators(),
  getTotalDeleted: (result) => result.deleted,
  getLogDetails: (result) => ({
    deleted: result.deleted,
    truncated: result.truncated,
  }),
});

/** Start the periodic prune. Safe to call once at server startup. */
export function startPlaceholderCreatorPruner(): void {
  pruner.start();
}

/** Stop the periodic prune. Called from the server's shutdown path. */
export function stopPlaceholderCreatorPruner(): void {
  pruner.stop();
}
