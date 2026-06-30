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
import { persistTip, updateCursor, readCursor } from "./persist.ts";
import { dispatchWebhooks } from "../modules/webhooks/webhooks.service.js";
import { sendTipNotification } from "../modules/notifications/email.service.js";

const POLL_INTERVAL_MS = 6_000;

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

  console.info(
    `[indexer] starting — contract=${contractId} network=${network.name}`,
  );

  // Determine start ledger: resume from cursor or use env override
  const savedCursor  = await readCursor();
  let   startLedger  = savedCursor > 0
    ? savedCursor + 1
    : config.stellar.indexerStartLedger;

  console.info(`[indexer] resuming from ledger ${startLedger}`);

  while (running) {
    try {
      const events = await fetchTipEvents({
        contractId,
        network,
        startLedger,
        limit: 200,
      });

      if (events.length > 0) {
        console.info(`[indexer] processing ${events.length} event(s) from ledger ${startLedger}`);

        for (const event of events) {
          await handleEvent(event);
          if (event.ledger > startLedger) {
            startLedger = event.ledger;
          }
        }

        await updateCursor(startLedger);
      }
    } catch (err) {
      console.error("[indexer] poll error:", err);
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
  console.info("[indexer] stopped");
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
    console.error(`[indexer] failed to handle event ${txHash}:`, err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
