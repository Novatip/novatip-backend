import {
  GENERIC_POLL_ERROR,
  getIndexerPollStatus,
  recordPollError,
  recordSuccessfulPoll,
} from "../../indexer/status.js";

describe("indexer poll status", () => {
  it("tracks successful poll timestamps and clears the previous error", () => {
    recordPollError(new Error("RPC unavailable"));
    expect(getIndexerPollStatus()).toEqual({
      lastSuccessfulPollAt: null,
      lastError: GENERIC_POLL_ERROR,
    });

    recordSuccessfulPoll();

    const status = getIndexerPollStatus();
    expect(status.lastSuccessfulPollAt).toEqual(expect.any(String));
    expect(
      status.lastSuccessfulPollAt === null
        ? Number.NaN
        : Date.parse(status.lastSuccessfulPollAt),
    ).not.toBeNaN();
    expect(status.lastError).toBeNull();
  });

  it("never exposes sensitive RPC URLs, connection strings, or stack traces in lastError", () => {
    const sensitive = new Error(
      "connect failed for https://rpc-secret.example.com/key=abc and postgresql://user:pass@db:5432/prod\n    at poll (src/indexer/indexer.ts:175:7)",
    );
    recordPollError(sensitive);

    const status = getIndexerPollStatus();
    expect(status.lastError).toBe(GENERIC_POLL_ERROR);
    expect(status.lastError).not.toContain("rpc-secret.example.com");
    expect(status.lastError).not.toContain("postgresql://");
    expect(status.lastError).not.toContain("at poll");
  });
});
