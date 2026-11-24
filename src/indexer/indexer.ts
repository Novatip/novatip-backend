/**
 * indexer/indexer.ts
 *
 * Soroban event indexer for Novatip.
 *
 * Polls the Soroban RPC for TipReceived events emitted by the tip_splitter
 * contract, decodes them via @novatip/sdk, persists them to PostgreSQL,
 * and dispatches webhook + email notifications.
 *
 * Design:
 *   - Runs as a long-lived async loop inside the same Node process.
 *   - Resumes from the last processed ledger stored in IndexerCursor.
 *   - Quiet periods still move the cursor: an empty batch advances it to chain
 *     head (throttled, see cursor.ts) so restarts don't re-scan idle ledgers.
 *   - startLedger is inclusive, so the loop advances past each ledger it has
 *     fully processed (see cursor.ts) — a tip is handled exactly once.
 *   - Idempotent: duplicate events are silently skipped (upsert on txHash).
 *   - Poll interval: 6 seconds (roughly one Stellar ledger close).
 */

import {
  fetchTipEvents,
  networkFromEnv,
  type NetworkConfig,
  type TipEvent,
} from "@novatip/sdk";
import { config } from "../config.js";
import {
  isIdleCheckDue,
  isRetentionWindowError,
  isSaturatedLedger,
  planBatch,
  planIdleAdvance,
  planRetentionRecovery,
} from "./cursor.js";
import { fetchLatestLedger } from "./rpc.js";
import { calculatePollBackoff } from "./backoff.js";
import { logger } from "../utils/logger.js";
import { persistTip, updateCursor, readCursor } from "./persist.js";
import { enqueueWebhookDispatch } from "../modules/webhooks/webhooks.service.js";
import { sendTipNotification } from "../modules/notifications/email.service.js";
import {
  recordPollError,
  recordSuccessfulPoll,
} from "./status.js";
import {
  updateIndexerCursor,
  updateIndexerLag,
} from "../modules/metrics/metrics.service.js";

/**
 * How often (in ms) the indexer loop polls the Soroban RPC for new TipReceived events.
 * Defaults to 6,000 ms (6 seconds), roughly matching Stellar's ~5s average ledger close time
 * so new events are discovered promptly without hammering the RPC.
 */
export const POLL_INTERVAL_MS = config.indexer.pollIntervalMs;

/**
 * Maximum number of TipReceived events fetched from Soroban RPC per poll iteration.
 * Defaults to 200, which provides high throughput during catch-up or backfill
 * without exceeding Soroban RPC getEvents page limits or overwhelming memory.
 */
export const POLL_LIMIT = config.indexer.pollLimit;

const indexerLogger = logger.child({ component: "indexer" });

// ── Build network config ──────────────────────────────────────────────────────

function resolveNetwork(): NetworkConfig {
  return networkFromEnv({
    name: config.stellar.network,
    rpcUrl: config.stellar.rpcUrl,
    horizonUrl: config.stellar.horizonUrl,
    passphrase: config.stellar.passphrase,
    usdcContractId: config.stellar.usdcContractId,
  });
}

// ── Indexer loop ──────────────────────────────────────────────────────────────

let running = false;
let wakeSleep: (() => void) | null = null;
let sleepTimeout: NodeJS.Timeout | null = null;

function cleanupSleep(): void {
  if (sleepTimeout) {
    clearTimeout(sleepTimeout);
    sleepTimeout = null;
  }
  wakeSleep = null;
}

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    wakeSleep = () => {
      cleanupSleep();
      resolve();
    };
    sleepTimeout = setTimeout(() => {
      cleanupSleep();
      resolve();
    }, ms);
  });
}

/**
 * The currently running loop, so stopIndexer() has something to await and a
 * second startIndexer() call while one is already in flight joins it rather
 * than starting a competing loop.
 */
let loop: Promise<void> | null = null;

export interface IndexerOptions {
  pollIntervalMs?: number;
  pollLimit?: number;
}

/**
 * Start the indexer loop. Safe to call more than once — a call made while
 * the loop is already running returns the same promise rather than starting
 * a second one. Logs errors but never crashes the process.
 */
export function startIndexer(options?: IndexerOptions): Promise<void> {
  if (loop) return loop;
  running = true;

  loop = runLoop(options).finally(() => {
    loop = null;
    cleanupSleep();
  });
  return loop;
}

async function runLoop(options?: IndexerOptions): Promise<void> {
  const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollLimit = options?.pollLimit ?? POLL_LIMIT;

  const network = resolveNetwork();
  const contractId = config.stellar.tipSplitterContractId;

  indexerLogger.info({ contractId, network: network.name }, "starting");

  // Determine start ledger: resume from cursor or use env override
  const savedCursor = await readCursor();
  let startLedger =
    savedCursor > 0 ? savedCursor + 1 : config.stellar.indexerStartLedger;

  // Cursor bookkeeping for quiet periods
  let persistedCursor = savedCursor;
  let lastIdleCheckAt: number | null = null;
  let consecutiveFailures = 0;

  indexerLogger.info({ startLedger }, "resuming from ledger");

  while (running) {
    try {
      // Read chain head *before* fetching so an empty batch provably covers
      // every ledger up to it. Only read when the idle check is due — it is an
      // extra RPC round trip that is pointless the rest of the time.
      let observedHead: number | null = null;

      if (isIdleCheckDue(Date.now(), lastIdleCheckAt)) {
        lastIdleCheckAt = Date.now();

        try {
          observedHead = await fetchLatestLedger(
            config.stellar.rpcUrl,
            config.stellar.rpcTimeoutMs,
          );
          // Update metrics with current lag
          if (observedHead !== null) {
            const lag = observedHead - startLedger;
            updateIndexerLag(lag >= 0 ? lag : 0);
          }
        } catch (err) {
          // Cursor freshness is an optimisation — never let it stop indexing.
          indexerLogger.warn({ err }, "could not read chain head");
        }
      }

      const events = await fetchTipEvents({
        contractId,
        network,
        startLedger,
        limit: pollLimit,
      });

      if (events.length > 0) {
        indexerLogger.info(
          { eventCount: events.length, startLedger },
          "processing events",
        );
        if (isSaturatedLedger(events, pollLimit)) {
          indexerLogger.warn(
            { ledger: events[0]!.ledger, limit: pollLimit },
            "ledger returned a full batch — any events beyond the limit are unreachable",
          );
        }

        const { toProcess, nextStartLedger, cursorLedger } = planBatch(
          events,
          startLedger,
          pollLimit,
        );

        for (const event of toProcess) {
          await handleEvent(event);
        }

        startLedger = nextStartLedger;

        if (cursorLedger !== null) {
          await updateCursor(cursorLedger);
          persistedCursor = cursorLedger;
          updateIndexerCursor(cursorLedger);
        }
      } else {
        // No tips in this range — advance to chain head so an idle stretch
        // doesn't turn into a backfill on the next restart.
        const advance = planIdleAdvance(
          observedHead,
          startLedger,
          persistedCursor,
        );

        if (advance) {
          indexerLogger.info(
            { cursorLedger: advance.cursorLedger },
            "idle — advancing cursor to chain head",
          );

          await updateCursor(advance.cursorLedger);
          startLedger = advance.nextStartLedger;
          persistedCursor = advance.cursorLedger;
          updateIndexerCursor(advance.cursorLedger);
        }
      }

      // Successful poll resets consecutive failure count
      consecutiveFailures = 0;
      recordSuccessfulPoll();
    } catch (err) {
      consecutiveFailures++;
      recordPollError(err);
      const backoffMs = calculatePollBackoff(
        consecutiveFailures,
        pollIntervalMs * 2,
      );
      indexerLogger.error(
        { err, startLedger, consecutiveFailures, backoffMs },
        "poll error",
      );

      if (isRetentionWindowError(err)) {
        try {
          const head = await fetchLatestLedger(
            config.stellar.rpcUrl,
            config.stellar.rpcTimeoutMs,
          );
          const recovery = planRetentionRecovery(head, startLedger);
          if (recovery) {
            indexerLogger.warn(
              {
                previousStartLedger: startLedger,
                newStartLedger: recovery.nextStartLedger,
                cursorLedger: recovery.cursorLedger,
                skippedLedgers: recovery.nextStartLedger - startLedger,
              },
              "startLedger outside RPC retention window — advancing to chain head",
            );
            await updateCursor(recovery.cursorLedger);
            startLedger = recovery.nextStartLedger;
            persistedCursor = recovery.cursorLedger;
            updateIndexerCursor(recovery.cursorLedger);
            updateIndexerLag(0);
          }
        } catch (headErr) {
          indexerLogger.warn(
            { err: headErr, startLedger },
            "could not read chain head during retention-window recovery",
          );
        }
      }

      if (!running) break;
      await interruptibleSleep(backoffMs);
      continue;
    }

    if (!running) break;
    await interruptibleSleep(pollIntervalMs);
  }

  indexerLogger.info("stopped");
}

/**
 * Stop the indexer loop and wait for its current iteration to finish.
 *
 * Setting running = false signals the loop to stop. If the loop is parked in
 * sleep between iterations or during error backoff, wakeSleep() wakes it
 * immediately rather than waiting out the sleep interval. An iteration already
 * in progress is still allowed to finish before the returned promise resolves.
 * Safe to call when the indexer is not running.
 */
export function stopIndexer(): Promise<void> {
  running = false;
  indexerLogger.info("stopping");
  if (wakeSleep) {
    wakeSleep();
  }
  return loop ?? Promise.resolve();
}

// ── Event handler ─────────────────────────────────────────────────────────────

/**
 * Persist a single TipEvent and dispatch webhook + email notifications when
 * the tip is newly created. Exported for tests.
 */
export async function handleEvent(event: TipEvent): Promise<void> {
  const txHash = event.txHash;

  const isNew = await persistTip(event, txHash);

  if (isNew) {
    recordTipIndexed();
    enqueueWebhookDispatch(event);

    try {
      await sendTipNotification(event);
    } catch (err) {
      indexerLogger.warn({ err, txHash }, "tip notification failed");
    }
  }
}
