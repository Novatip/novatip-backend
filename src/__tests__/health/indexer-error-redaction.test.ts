import Fastify from "fastify";
import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const readCursorMock = jest.fn<() => Promise<number>>(async () => 123);
const fetchLatestLedgerMock =
  jest.fn<(url: string, timeoutMs: number) => Promise<number>>(async () => 150);

jest.unstable_mockModule("../../indexer/persist.js", () => ({
  readCursor: readCursorMock,
}));

jest.unstable_mockModule("../../indexer/rpc.js", () => ({
  fetchLatestLedger: fetchLatestLedgerMock,
}));

const { GENERIC_POLL_ERROR, recordPollError, recordSuccessfulPoll } =
  await import("../../indexer/status.js");
const { healthRoutes } = await import("../../modules/health/health.routes.js");

describe("GET /health/indexer error redaction (#286)", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(healthRoutes, { prefix: "/health" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    recordSuccessfulPoll();
  });

  it("never leaks RPC URLs, connection strings, or stack traces via lastError", async () => {
    recordPollError(
      new Error(
        "Request to https://rpc.internal.example.com/v1?apiKey=secret failed; postgresql://admin:secret@db.internal:5432/novatip\n    at fetchTipEvents (src/indexer/indexer.ts:175:22)",
      ),
    );

    const response = await app.inject({
      method: "GET",
      url: "/health/indexer",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cursorLedger: 123,
      chainHead: { status: "known", ledger: 150 },
      lastError: GENERIC_POLL_ERROR,
    });
    expect(response.body).not.toContain("rpc.internal.example.com");
    expect(response.body).not.toContain("apiKey");
    expect(response.body).not.toContain("postgresql://");
    expect(response.body).not.toContain("admin:secret");
    expect(response.body).not.toContain("fetchTipEvents");
  });
});
