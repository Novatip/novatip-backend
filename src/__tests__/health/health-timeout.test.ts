import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const mockQueryRaw = jest.fn(async () => await new Promise<never>(() => {}));

jest.unstable_mockModule("../../db.js", () => ({
  db: { $queryRaw: mockQueryRaw },
}));
jest.unstable_mockModule("../../redis.js", () => ({
  redis: { ping: jest.fn(async () => "PONG") },
}));

const { checkDatabase } =
  await import("../../modules/health/health.service.js");

describe("readiness probe timeout", () => {
  let pendingResolvers: Array<() => void> = [];

  afterEach(async () => {
    for (const resolve of pendingResolvers) {
      resolve();
    }
    pendingResolvers = [];
    await Promise.resolve();
    jest.useRealTimers();
    mockQueryRaw.mockReset();
  });

  it("reports a probe that never settles as down after its deadline", async () => {
    jest.useFakeTimers();
    mockQueryRaw.mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          pendingResolvers.push(resolve as () => void);
        }),
    );

    const result = checkDatabase();
    await jest.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({
      status: "down",
      latencyMs: 2_000,
      error: "probe timed out after 2000ms",
    });
  });

  it("coalesces repeated probes after timeout and cleans up once the dependency responds", async () => {
    jest.useFakeTimers();

    let resolveHungQuery!: () => void;
    mockQueryRaw
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveHungQuery = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined as never);

    // First probe times out after 2000ms.
    const first = checkDatabase();
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toMatchObject({ status: "down" });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);

    // A second probe while the first is still pending must not open another query.
    const second = checkDatabase();
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(second).resolves.toMatchObject({ status: "down" });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);

    // Once the hung dependency finally responds, the in-flight slot is cleared.
    resolveHungQuery();
    await Promise.resolve();
    await Promise.resolve();

    // A subsequent probe starts a fresh query and succeeds with no orphaned state.
    const third = await checkDatabase();
    expect(third).toMatchObject({ status: "up" });
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
  });
});
