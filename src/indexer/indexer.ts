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
  getNetwork,
  networkFromEnv,
  type NetworkConfig,
  type TipEvent,
} from "@novatip/sdk";
import { config } from "../config.js";
import { isIdleCheckDue, planIdleAdvance } from "./cursor.js";
import { fetchLatestLedger } from "./rpc.js";
import { logger } from "../utils/logger.js";
import { planBatch, isSaturatedLedger } from "./cursor.js";
import { persistTip, updateCursor, readCursor } from "./persist.ts";
import { dispatchWebhooks } from "../modules/webhooks/webhooks.service.js";
import { sendTipNotification } from "../modules/notifications/email.service.js";

const POLL_INTERVAL_MS = 6_000;
const POLL_LIMIT       = 200;

const indexerLogger = logger.child({ component: "indexer" });

// ── Build network config ──────────────────────────────────────────────────────

function resolveNetwork(): NetworkConfig {
  if (config.stellar.rpcUrl) {
    return networkFromEnv({
      name:           config.stellar.network,
      rpcUrl:         config.stellar.rpcUrl,
      horizonUrl:     config.stellar.horizonUrl,
      passphrase:     config.stellar.passphrase,
      usdcContractId: config.stellar.usdcContractId,
    });
  }
  return getNetwork(config.stellar.network);
}

// ── Indexer loop ──────────────────────────────────────────────────────────────

let running = false;

/**
 * Start the indexer loop. Safe to call once at server startup.
 * Logs errors but never crashes the process.
 */
export async function startIndexer(): Promise<void> {
  if (running) return;
  running = true;

  const network      = resolveNetwork();
  const contractId   = config.stellar.tipSplitterContractId;

  indexerLogger.info(
    { contractId, network: network.name },
    "starting",
  );

  // Determine start ledger: resume from cursor or use env override
  const savedCursor  = await readCursor();
  let   startLedger  = savedCursor > 0
    ? savedCursor + 1
    : config.stellar.indexerStartLedger;

  // Cursor bookkeeping for quiet periods
  let persistedCursor  = savedCursor;
  let lastIdleCheckAt: number | null = null;

  console.info(`[indexer] resuming from ledger ${startLedger}`);
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
          observedHead = await fetchLatestLedger(config.stellar.rpcUrl);
        } catch (err) {
          // Cursor freshness is an optimisation — never let it stop indexing.
          console.warn("[indexer] could not read chain head:", err);
        }
      }

      const events = await fetchTipEvents({
        contractId,
        network,
        startLedger,
        limit: POLL_LIMIT,
      });

      if (events.length > 0) {
        indexerLogger.info(
          { eventCount: events.length, startLedger },
          "processing events",
        );
        if (isSaturatedLedger(events, POLL_LIMIT)) {
          console.warn(
            `[indexer] ledger ${events[0]!.ledger} returned a full batch of ${POLL_LIMIT} event(s) — any beyond that are unreachable`,
          );
        }

        const { toProcess, nextStartLedger, cursorLedger } = planBatch(
          events,
          startLedger,
          POLL_LIMIT,
        );

        console.info(`[indexer] processing ${toProcess.length} event(s) from ledger ${startLedger}`);

        for (const event of toProcess) {
          await handleEvent(event);
        }

        await updateCursor(startLedger);
        persistedCursor = startLedger;
      } else {
        // No tips in this range — advance to chain head so an idle stretch
        // doesn't turn into a backfill on the next restart.
        const advance = planIdleAdvance(observedHead, startLedger, persistedCursor);

        if (advance) {
          console.info(`[indexer] idle — advancing cursor to ledger ${advance.cursorLedger}`);

          await updateCursor(advance.cursorLedger);
          startLedger     = advance.nextStartLedger;
          persistedCursor = advance.cursorLedger;
        // Advance past the ledgers just handled — startLedger is inclusive, so
        // leaving it on a processed ledger re-runs webhooks and emails.
        startLedger = nextStartLedger;

        if (cursorLedger !== null) {
          await updateCursor(cursorLedger);
        }
      }
    } catch (err) {
      indexerLogger.error({ err, startLedger }, "poll error");
      // Back off slightly on error to avoid hammering the RPC
      await sleep(POLL_INTERVAL_MS * 2);
      continue;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Stop the indexer loop gracefully.
 */
export function stopIndexer(): void {
  running = false;
  indexerLogger.info("stopped");
}

// ── Event handler ─────────────────────────────────────────────────────────────

async function handleEvent(event: TipEvent): Promise<void> {
  // Use jarId + ledger as a synthetic txHash when a real hash isn't available
  const txHash = `${event.jarId}:${event.ledger}:${event.from}`;

  try {
    await persistTip(event, txHash);
    await dispatchWebhooks(event);
    await sendTipNotification(event);
  } catch (err) {
    indexerLogger.error({ err, txHash }, "failed to handle event");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
