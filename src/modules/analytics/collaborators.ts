/**
 * analytics/collaborators.ts
 *
 * Per-recipient earnings for a shared jar.
 *
 * A jar splits every tip across collaborators, but analytics only ever
 * reported totals for the jar as a whole — so a creator in a three-way band
 * could not answer "how much has each of us earned", which is the first
 * question a shared jar raises. The split percentages are already on the
 * creator record, so the breakdown is derivable from the indexed tips with no
 * new on-chain reads.
 *
 * Everything here is in stroops, as strings and BigInt. Amounts are i128 on
 * chain and stored as text for that reason; routing them through a JS number
 * would start losing the low digits at around 90 billion stroops (~9,000 USDC)
 * and would do it silently.
 */

/** A split as stored in Creator.splits: basis points to a Stellar address. */
export interface Split {
  to: string;
  bps: number;
}

/** One recipient's share of the jar and what it has earned so far. */
export interface CollaboratorEarnings {
  /** Recipient Stellar address. */
  to: string;
  /** Share in basis points, as stored on the creator record. */
  bps: number;
  /** The same share as a percentage string, e.g. "33.33" — never a float. */
  sharePercent: string;
  /** Total earned across the creator's indexed tips, in stroops. */
  totalEarnedRaw: string;
}

const BPS_TOTAL = 10_000;

/**
 * Validate and normalise Creator.splits.
 *
 * Creator.splits is a Json column written from a request body, so by the time
 * it is read back it is only as well-formed as whatever last wrote it. This
 * endpoint reports money: a malformed entry has to fail loudly rather than be
 * skipped, because a silently dropped recipient reads as "you earned nothing".
 */
export function parseSplits(value: unknown): Split[] {
  if (!Array.isArray(value)) throw malformedSplits("splits is not an array");

  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw malformedSplits(`splits[${i}] is not an object`);
    }

    const { to, bps } = entry as Record<string, unknown>;

    if (typeof to !== "string" || to.trim() === "") {
      throw malformedSplits(`splits[${i}].to is not an address`);
    }
    if (typeof bps !== "number" || !Number.isInteger(bps)) {
      throw malformedSplits(`splits[${i}].bps is not an integer`);
    }
    if (bps < 0 || bps > BPS_TOTAL) {
      throw malformedSplits(`splits[${i}].bps is outside 0–${BPS_TOTAL}`);
    }

    return { to, bps };
  });
}

/**
 * Stored splits that do not parse are a server-side data fault, not a bad
 * request — the caller sent nothing wrong. 500 is the honest status; the
 * message names the offending index so it can be found and fixed.
 */
function malformedSplits(detail: string): Error {
  return Object.assign(new Error(`Stored splits are malformed: ${detail}.`), {
    statusCode: 500,
    code: "MALFORMED_SPLITS",
  });
}

/**
 * Basis points as a percentage string with two decimals.
 *
 * Done with integer arithmetic rather than bps / 100: the point of this
 * endpoint is that nothing about a creator's earnings passes through a float,
 * and a share is part of that story even though it is not itself an amount.
 */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const hundredths = Math.abs(bps % 100);
  return `${whole}.${String(hundredths).padStart(2, "0")}`;
}

/**
 * Parse a stroop amount returned by Postgres as text.
 *
 * Sums come back from `numeric` as text precisely so they are not rounded on
 * the way out. A value with a fractional part would mean the query changed
 * shape — stroops are indivisible — so it is rejected rather than truncated
 * into something that looks plausible.
 */
export function parseStroops(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (!/^-?[0-9]+$/.test(value)) {
    throw Object.assign(
      new Error(`Expected a whole stroop amount, got "${value}".`),
      { statusCode: 500, code: "NON_INTEGRAL_STROOPS" },
    );
  }
  return BigInt(value);
}

/**
 * Whatever the per-recipient shares do not account for.
 *
 * Two things land here. Splits need not sum to 10000 bps — the contract pays
 * the balance to the jar owner — and each per-tip share is truncated down to a
 * whole stroop, so a few stroops of rounding dust are left over on most tips.
 * Reporting the remainder explicitly means the breakdown always adds up to the
 * jar total, instead of the difference being left for the reader to notice.
 */
export function unallocated(total: bigint, shares: bigint[]): bigint {
  return shares.reduce((rest, share) => rest - share, total);
}
