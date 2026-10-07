/**
 * analytics/cursor.ts
 *
 * Opaque cursors for paging a creator's tips newest-first.
 *
 * Offset paging is wrong for a feed that grows at the head: a tip indexed
 * between two requests shifts every subsequent page down by one, so a client
 * scrolling back through their history sees a row twice and misses the row
 * after it. A cursor keyed on the row's own ordering has no such window.
 *
 * The ordering is ("ledgerAt" DESC, <key> DESC). ledgerAt alone is not unique —
 * several tips can share a ledger close time — so a unique column is carried
 * alongside it as a tiebreaker; without one a page boundary landing inside a
 * group of tips with equal ledgerAt would either repeat or skip the rest of
 * that group. Which column plays that role is the caller's choice, since it
 * has to be a column the caller is willing to put in the cursor.
 *
 * The encoding is base64url over "<iso>|<key>" and is deliberately opaque: it
 * is a position in a result set, not an API surface. Clients echo back what
 * the previous response handed them.
 */

/** The unique column a caller orders by after ledgerAt. */
export type TipCursorKey = "id" | "txHash";

/** A decoded page boundary: the last row of the previous page. */
export interface TipCursor {
  ledgerAt: Date;
  key: string;
}

const SEPARATOR = "|";

function badCursor(): Error {
  // A malformed cursor is a bad request, not a server fault — without a
  // statusCode the global error handler would report it as a 500.
  return Object.assign(
    new Error("Invalid cursor. Use the nextCursor from a previous response."),
    { statusCode: 400, code: "INVALID_CURSOR" },
  );
}

/** Encode the row a page ended on into the cursor for the page after it. */
export function encodeTipCursor(ledgerAt: Date, key: string): string {
  const raw = `${ledgerAt.toISOString()}${SEPARATOR}${key}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/**
 * Decode a cursor supplied by a client.
 *
 * Throws a 400 for anything that is not a cursor this module produced: the
 * value reaches a `WHERE` clause, and a half-parsed one (an Invalid Date, an
 * empty key) would silently page from the wrong place rather than fail.
 */
export function decodeTipCursor(raw: string): TipCursor {
  if (typeof raw !== "string" || raw.trim() === "") throw badCursor();

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
 *
 * Expressed as an OR rather than a row-value comparison because Prisma has no
 * `(a, b) < (x, y)`: either the row is in an older ledger, or it shares the
 * cursor's ledger and sorts lower by the tiebreaker.
 */
export function cursorFilter(cursor: TipCursor, keyField: TipCursorKey) {
  return {
    OR: [
      { ledgerAt: { lt: cursor.ledgerAt } },
      { ledgerAt: cursor.ledgerAt, [keyField]: { lt: cursor.key } },
    ],
  };
}
