/**
 * __tests__/indexer/rpc.test.ts
 *
 * Covers the getLatestLedger helper the idle cursor policy depends on.
 * A bad response must throw rather than yield a bogus ledger — the caller
 * treats a thrown error as "skip the idle advance this poll", but a bogus
 * number would move the cursor somewhere wrong.
 */

import { jest } from "@jest/globals";
import { fetchLatestLedger } from "../../indexer/rpc.js";

const RPC_URL = "https://soroban-testnet.stellar.org";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const mockFetch = jest.fn<typeof fetch>();
const realFetch = globalThis.fetch;

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("fetchLatestLedger", () => {
  it("returns the ledger sequence", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { id: "abc", sequence: 1_234 },
      }),
    );

    await expect(fetchLatestLedger(RPC_URL)).resolves.toBe(1_234);
  });

  it("posts a getLatestLedger JSON-RPC request", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ result: { sequence: 1 } }));

    await fetchLatestLedger(RPC_URL);

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(RPC_URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "getLatestLedger",
    });
  });

  it("throws on a non-2xx response", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false, 503));

    await expect(fetchLatestLedger(RPC_URL)).rejects.toThrow("HTTP 503");
  });

  it("throws on a JSON-RPC error payload", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: { code: -32601, message: "method not found" } }),
    );

    await expect(fetchLatestLedger(RPC_URL)).rejects.toThrow(
      "method not found",
    );
  });

  it("throws when the response carries no sequence", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ result: {} }));

    await expect(fetchLatestLedger(RPC_URL)).rejects.toThrow(
      "no ledger sequence",
    );
  });

  it("throws rather than returning a non-numeric sequence", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ result: { sequence: "1234" } }));

    await expect(fetchLatestLedger(RPC_URL)).rejects.toThrow(
      "no ledger sequence",
    );
  });

  it("propagates a network failure", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(fetchLatestLedger(RPC_URL)).rejects.toThrow("ECONNREFUSED");
  });
});
