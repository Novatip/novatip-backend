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

const SEPARATOR = "|";

/**
 * Maximum length of a base64url-encoded cursor accepted by decodeTipCursor.
 *
 * Every cursor this server issues is "<24-char ISO timestamp>|<cuid or 64-char txHash>"
 * (~50-90 bytes, ~68-120 base64url chars). Capping at 256 chars comfortably
 * fits every legitimate cursor while preventing unauthenticated callers from
 * inflating Redis cache keys with arbitrarily long cursor strings.
 */
export const MAX_CURSOR_LENGTH = 256;

function badCursor(): Error {
  // A malformed cursor is a bad request, not a server fault — without a
  // statusCode the global error handler would report it as a 500.
  return Object.assign(
    new Error("Invalid cursor. Use the nextCursor from a previous response."),
    { statusCode: 400, code: "INVALID_CURSOR" },
  );
}

/** Encode the row a page ended on into the cursor for the page after it. */
export const encodeTipCursor = encodeCursor;

/**
 * Decode a cursor supplied by a client.
 * Throws a 400 for anything that is not a cursor this module produced.
 */
export function decodeTipCursor(raw: string): TipCursor {
  if (
    typeof raw !== "string" ||
    raw.trim() === "" ||
    raw.length > MAX_CURSOR_LENGTH
  ) {
    throw badCursor();
  }

  const decoded = Buffer.from(raw, "base64url").toString("utf8");

  // base64url decoding never fails outright — it discards what it cannot
  // read — so the shape of the result is what has to be checked.
  const separator = decoded.indexOf(SEPARATOR);
  if (separator === -1) throw badCursor();

  const iso = decoded.slice(0, separator);
  const key = decoded.slice(separator + 1);
  if (key === "") throw badCursor();

  const ledgerAt = new Date(iso);
  if (Number.isNaN(ledgerAt.getTime())) throw badCursor();

  // Round-trip the timestamp: a truncated or re-encoded cursor can parse as a
  // Date while meaning a different instant than the one it was issued for.
  if (ledgerAt.toISOString() !== iso) throw badCursor();

  return { ledgerAt, key };
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
