/**
 * indexer/persist.ts
 *
 * Persists a decoded TipEvent to PostgreSQL and updates the indexer cursor.
 * Called by the indexer loop after each confirmed event batch.
 */

import type { TipEvent } from "@novatip/sdk";
import { db } from "../db.js";

/**
 * Persist a single TipEvent.
 * Uses upsert on txHash so re-runs are idempotent.
 *
 * @param event     - Decoded TipEvent from the SDK event parser
 * @param txHash    - Soroban transaction hash (used as idempotency key)
 */
export async function persistTip(event: TipEvent, txHash: string): Promise<void> {
  // Resolve creator by jarId
  const creator = await db.creator.findUnique({
    where: { jarId: event.jarId },
  });

  if (!creator) {
    // Jar not registered in our DB — skip silently (could be another app)
    return;
  }

  await db.tip.upsert({
    where:  { txHash },
    update: {}, // already persisted — no-op
    create: {
      txHash,
      ledger:      event.ledger,
      ledgerAt:    new Date(event.timestamp),
      fromAddress: event.from,
      amount:      event.amount.toString(),
      message:     event.message,
      creatorId:   creator.id,
    },
  });
}

/**
 * Update the indexer cursor to the last processed ledger.
 * Uses upsert on the single-row IndexerCursor table (id = 1).
 */
export async function updateCursor(ledger: number): Promise<void> {
  await db.indexerCursor.upsert({
    where:  { id: 1 },
    update: { lastLedger: ledger },
    create: { id: 1, lastLedger: ledger },
  });
}

/**
 * Read the last processed ledger from the cursor table.
 * Returns 0 if the cursor has never been set.
 */
export async function readCursor(): Promise<number> {
  const cursor = await db.indexerCursor.findUnique({ where: { id: 1 } });
  return cursor?.lastLedger ?? 0;
}
