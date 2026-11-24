/**
 * utils/batch-pruner.ts
 *
 * Shared scheduling loop and policy constants for batched retention pruners.
 *
 * Pruners self-reschedule on completion rather than firing on a fixed interval,
 * so a slow pass against a large backlog can never overlap the next. Timeouts
 * are unref'd so background housekeeping never prevents the process from
 * exiting cleanly.
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Ceiling on batches per run, shared across classes. A first run against a
 * years-old table has more to delete than one pass should attempt; stopping
 * early leaves the rest for the next tick rather than running a single
 * multi-hour transaction.
 */
export const MAX_BATCHES_PER_RUN = 50;

/** Delay before the first prune, so it doesn't compete with server startup. */
export const FIRST_RUN_DELAY_MS = 60_000;

/** The timestamp before which rows of a given age are eligible for deletion. */
export function cutoffFor(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

export interface BatchPrunerLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface BatchPrunerOptions<TResult extends { truncated: boolean }> {
  /** Logger instance used for lifecycle and error events. */
  logger: BatchPrunerLogger;
  /** Name of the pruner, used in start and failure log messages (e.g. "placeholder creator"). */
  name: string;
  /** Description used in truncated and completion log messages (e.g. "placeholder creators", "retained rows"). */
  description?: string;
  /** Gate returning true if retention is enabled. */
  retentionEnabled: () => boolean;
  /** Message logged when retention is disabled at start time. */
  disabledMessage: string;
  /** Metadata to log when the pruner starts. */
  getStartMetadata?: () => Record<string, unknown>;
  /** Delay in milliseconds before the first prune (defaults to FIRST_RUN_DELAY_MS). */
  firstRunDelayMs?: number;
  /** Interval in milliseconds between subsequent runs. */
  getIntervalMs: () => number;
  /** The prune operation to execute. */
  runPrune: () => Promise<TResult>;
  /** Optional function to determine total deleted count. */
  getTotalDeleted?: (result: TResult) => number;
  /** Optional function providing details object for the summary log. */
  getLogDetails?: (result: TResult) => Record<string, unknown>;
}

export interface BatchPruner {
  start: () => void;
  stop: () => void;
}

export function createBatchPruner<TResult extends { truncated: boolean }>(
  options: BatchPrunerOptions<TResult>,
): BatchPruner {
  const {
    logger,
    name,
    description = name,
    retentionEnabled,
    disabledMessage,
    getStartMetadata,
    firstRunDelayMs = FIRST_RUN_DELAY_MS,
    getIntervalMs,
    runPrune,
    getTotalDeleted,
    getLogDetails,
  } = options;

  let pruneTimer: NodeJS.Timeout | null = null;
  let pruneActive = false;

  function scheduleNext(delayMs: number): void {
    pruneTimer = setTimeout(() => {
      void execute();
    }, delayMs);

    // Housekeeping must never be the reason the process stays alive.
    pruneTimer.unref();
  }

  async function execute(): Promise<void> {
    if (!pruneActive) return;

    try {
      const result = await runPrune();

      const total = getTotalDeleted
        ? getTotalDeleted(result)
        : (result as { deleted?: number }).deleted ?? 0;

      if (total > 0) {
        const details = getLogDetails
          ? getLogDetails(result)
          : { deleted: total, truncated: result.truncated };

        logger.info(
          details,
          result.truncated
            ? `pruned ${description} — batch ceiling reached, continuing next run`
            : `pruned ${description}`,
        );
      }
    } catch (err) {
      // Retention is housekeeping: a failed pass is logged and retried on the
      // next tick, never allowed to take the server down.
      logger.error({ err }, `${name} prune failed`);
    }

    if (pruneActive) {
      scheduleNext(getIntervalMs());
    }
  }

  function start(): void {
    if (pruneTimer !== null || pruneActive) return;

    if (!retentionEnabled()) {
      logger.info(disabledMessage);
      return;
    }

    const metadata = getStartMetadata ? getStartMetadata() : {};
    logger.info(metadata, `starting ${name} pruner`);

    pruneActive = true;
    scheduleNext(firstRunDelayMs);
  }

  function stop(): void {
    pruneActive = false;

    if (pruneTimer !== null) {
      clearTimeout(pruneTimer);
      pruneTimer = null;
    }
  }

  return { start, stop };
}
