/**
 * indexer/rpc.ts
 *
 * Minimal Soroban RPC helper for the indexer.
 *
 * Only `getLatestLedger` is needed: during quiet periods the event fetch
 * returns nothing, so chain head is the only way to learn how far the indexer
 * has safely scanned. Issued as a plain JSON-RPC call rather than through the
 * SDK so the indexer keeps a single event-shaped dependency on it.
 */

const TIMEOUT_MS = 5_000;

interface LatestLedgerResponse {
  result?: { sequence?: number };
  error?: { message?: string };
}

/**
 * Fetch the sequence number of the latest closed ledger.
 *
 * @param rpcUrl - Soroban RPC endpoint
 * @throws if the endpoint is unreachable, times out, or returns no sequence
 */
export async function fetchLatestLedger(rpcUrl: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    throw new Error(`getLatestLedger failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as LatestLedgerResponse;

  if (body.error) {
    throw new Error(
      `getLatestLedger failed: ${body.error.message ?? "unknown RPC error"}`,
    );
  }

  const sequence = body.result?.sequence;

  if (typeof sequence !== "number" || !Number.isFinite(sequence)) {
    throw new Error("getLatestLedger returned no ledger sequence");
  }

  return sequence;
}
