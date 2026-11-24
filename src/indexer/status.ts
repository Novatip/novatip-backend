export interface IndexerPollStatus {
  lastSuccessfulPollAt: string | null;
  lastError: string | null;
}

/**
 * Generic error string exposed by public health endpoints so internal RPC URLs,
 * database connection details, and stack traces are never leaked.
 */
export const GENERIC_POLL_ERROR = "Indexer poll failed.";

let lastSuccessfulPollAt: string | null = null;
let lastError: string | null = null;

export function recordSuccessfulPoll(): void {
  lastSuccessfulPollAt = new Date().toISOString();
  lastError = null;
}

export function recordPollError(_error: unknown): void {
  lastError = GENERIC_POLL_ERROR;
}

export function getIndexerPollStatus(): IndexerPollStatus {
  return { lastSuccessfulPollAt, lastError };
}
