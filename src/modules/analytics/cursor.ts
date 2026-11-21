/**
 * analytics/cursor.ts
 *
 * Thin tip-specific adapter over utils/cursor.ts for paging a creator's tips
 * newest-first in ("ledgerAt" DESC, <key> DESC) order.
 */

import {
  cursorFilter as genericCursorFilter,
  decodeCursor,
  encodeCursor,
} from "../../utils/cursor.js";

/** The unique column a caller orders by after ledgerAt. */
export type TipCursorKey = "id" | "txHash";

/** A decoded page boundary: the last row of the previous page. */
export interface TipCursor {
  ledgerAt: Date;
  key: string;
}

/** Encode the row a page ended on into the cursor for the page after it. */
export const encodeTipCursor = encodeCursor;

/**
 * Decode a cursor supplied by a client.
 * Throws a 400 for anything that is not a cursor this module produced.
 */
export function decodeTipCursor(raw: string): TipCursor {
  const { timestamp, key } = decodeCursor(raw);
  return { ledgerAt: timestamp, key };
}

/**
 * The Prisma `where` fragment selecting rows strictly after `cursor` in
 * ("ledgerAt" DESC, <keyField> DESC) order.
 */
export function cursorFilter<K extends TipCursorKey>(
  cursor: TipCursor,
  keyField: K,
) {
  return genericCursorFilter(
    { timestamp: cursor.ledgerAt, key: cursor.key },
    "ledgerAt",
    keyField,
  );
}
