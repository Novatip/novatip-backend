/**
 * cursor.ts
 *
 * Generic cursor-based pagination utilities for ordered feeds.
 *
 * Cursor paging solves the offset-shift problem: when a feed grows at the head,
 * offset-based pages shift by one for every new row inserted mid-scroll. A cursor
 * names the row the previous page ended on, so new arrivals never displace boundaries
 * already handed out.
 */

/** A decoded page boundary: the last row of the previous page. */
export interface Cursor {
  timestamp: Date;
  key: string;
}

const SEPARATOR = "|";

function badCursor(): Error {
  return Object.assign(
    new Error("Invalid cursor. Use the nextCursor from a previous response."),
    { statusCode: 400, code: "INVALID_CURSOR" },
  );
}

/** Encode a row's timestamp and unique key into an opaque cursor. */
export function encodeCursor(timestamp: Date, key: string): string {
  const raw = `${timestamp.toISOString()}${SEPARATOR}${key}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/**
 * Decode a cursor supplied by a client.
 * Throws a 400 for anything that is not a cursor this module produced.
 */
export function decodeCursor(raw: string): Cursor {
  if (typeof raw !== "string" || raw.trim() === "") throw badCursor();

  const decoded = Buffer.from(raw, "base64url").toString("utf8");

  const separator = decoded.indexOf(SEPARATOR);
  if (separator === -1) throw badCursor();

  const iso = decoded.slice(0, separator);
  const key = decoded.slice(separator + 1);
  if (key === "") throw badCursor();

  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) throw badCursor();

  // Round-trip the timestamp to catch truncated or re-encoded cursors
  if (timestamp.toISOString() !== iso) throw badCursor();

  return { timestamp, key };
}

/**
 * Generate a Prisma where clause for rows strictly after the cursor
 * in (timestampField DESC, keyField DESC) order.
 */
export function cursorFilter<T extends string, K extends string>(
  cursor: Cursor,
  timestampField: T,
  keyField: K,
): {
  OR: [
    Record<T, { lt: Date }>,
    Record<T, Date> & Record<K, { lt: string }>,
  ];
} {
  return {
    OR: [
      { [timestampField]: { lt: cursor.timestamp } } as Record<T, { lt: Date }>,
      {
        [timestampField]: cursor.timestamp,
        [keyField]: { lt: cursor.key },
      } as Record<T, Date> & Record<K, { lt: string }>,
    ],
  };
}
