/**
 * Tip-history CSV export: RFC 4180 values, bounded keyset paging, and the
 * authenticated download response.
 */

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR_ID = "creator-1";
const BOM = "\uFEFF";

interface Row {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  message: string;
  ledgerAt: Date;
  creatorId: string;
}

interface FindManyArgs {
  where: {
    creatorId: string;
    OR?: Array<Record<string, unknown>>;
  };
  take: number;
}

let rows: Row[] = [];

function matchesCursor(
  row: Row,
  clauses?: Array<Record<string, unknown>>,
): boolean {
  if (clauses === undefined) return true;

  return clauses.some((clause) =>
    Object.entries(clause).every(([field, condition]) => {
      const value = row[field as keyof Row];
      if (condition instanceof Date) {
        return (value as Date).getTime() === condition.getTime();
      }
      const lt = (condition as { lt: Date | string }).lt;
      if (lt instanceof Date) return (value as Date).getTime() < lt.getTime();
      return String(value) < lt;
    }),
  );
}

function newestFirst(left: Row, right: Row): number {
  const byLedger = right.ledgerAt.getTime() - left.ledgerAt.getTime();
  if (byLedger !== 0) return byLedger;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

const findMany = jest.fn(async (args: FindManyArgs): Promise<Row[]> =>
  rows
    .filter(
      (row) =>
        row.creatorId === args.where.creatorId &&
        matchesCursor(row, args.where.OR),
    )
    .sort(newestFirst)
    .slice(0, args.take),
);

const findCreator = jest.fn(async () => ({ slug: "alice" }));

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    tip: { findMany },
    creator: { findUnique: findCreator },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  redis: {},
  cacheGet: async (): Promise<null> => null,
  cacheSet: async (): Promise<void> => undefined,
  cacheInvalidate: async (): Promise<void> => undefined,
  cacheInvalidatePrefix: async (): Promise<void> => undefined,
  revokeCreatorTokens: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("@fastify/rate-limit", () => ({
  default: async (): Promise<void> => undefined,
}));

const { streamTipHistoryCsv } =
  await import("../../modules/analytics/analytics.service.js");
const { analyticsRoutes } =
  await import("../../modules/analytics/analytics.routes.js");

function makeRow(id: number, ledgerAt: Date, message = `tip ${id}`): Row {
  const paddedId = String(id).padStart(4, "0");
  return {
    id: `tip_${paddedId}`,
    txHash: `hash_${paddedId}`,
    fromAddress: `GSENDER${paddedId}`,
    amount: String(id * 10_000_000),
    message,
    ledgerAt,
    creatorId: CREATOR_ID,
  };
}

async function readCsv(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of streamTipHistoryCsv(CREATOR_ID)) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("user", null);
  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers.authorization !== "Bearer valid-token") {
        await reply.status(401).send({ error: "unauthorized" });
        return;
      }
      request.user = {
        sub: CREATOR_ID,
        wallet: "GWALLET",
        slug: "alice",
      };
    },
  );
  await app.register(analyticsRoutes, { prefix: "/analytics" });
  await app.ready();
  return app;
}

beforeEach(() => {
  rows = [];
  findMany.mockClear();
  findCreator.mockClear();
});

describe("streamTipHistoryCsv", () => {
  it("returns only the header for an empty history", async () => {
    await expect(readCsv()).resolves.toBe(
      `${BOM}id,txHash,fromAddress,amount,message,ledgerAt\n`,
    );
  });

  it("begins with a UTF-8 BOM followed by the header row", async () => {
    const chunks: string[] = [];
    for await (const chunk of streamTipHistoryCsv(CREATOR_ID)) {
      chunks.push(chunk);
    }
    const bytes = Buffer.from(chunks.join(""), "utf8");

    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toMatch(
      /^id,txHash,fromAddress,amount,message,ledgerAt\n/,
    );
  });

  it("escapes commas, double quotes, and line breaks in a message", async () => {
    rows = [
      makeRow(1, new Date("2026-10-20T12:34:56.000Z"), 'Thanks, "Ada"\nAgain'),
    ];

    await expect(readCsv()).resolves.toBe(
      `${BOM}id,txHash,fromAddress,amount,message,ledgerAt\n` +
        'tip_0001,hash_0001,GSENDER0001,10000000,"Thanks, ""Ada""\nAgain",2026-10-20T12:34:56.000Z\n',
    );
  });

  it("pages through shared ledger times without duplicates or gaps", async () => {
    const newest = new Date("2026-10-20T12:00:00.000Z");
    const sharedBoundary = new Date("2026-10-19T12:00:00.000Z");
    const oldest = new Date("2026-10-18T12:00:00.000Z");

    rows = Array.from({ length: 503 }, (_, offset) => {
      const id = offset + 1;
      const ledgerAt = id > 8 ? newest : id > 3 ? sharedBoundary : oldest;
      return makeRow(id, ledgerAt);
    });
    const expectedIds = [...rows].sort(newestFirst).map((row) => row.id);

    const csv = await readCsv();
    const exportedIds = csv
      .replace(BOM, "")
      .trimEnd()
      .split("\n")
      .slice(1)
      .map((line) => line.split(",", 1)[0]);

    expect(exportedIds).toEqual(expectedIds);
    expect(new Set(exportedIds).size).toBe(503);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe("GET /analytics/export", () => {
  it("sets download headers and disables caching", async () => {
    const app = await buildTestServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/analytics/export",
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(response.headers["content-disposition"]).toBe(
        'attachment; filename="alice-tip-history.csv"',
      );
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("returns 401 without a token", async () => {
    const app = await buildTestServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/analytics/export",
      });

      expect(response.statusCode).toBe(401);
      expect(findCreator).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test.each([
    "/analytics/csv",
    "/analytics/recent.csv",
    "/analytics/export.csv",
    "/analytics/tips.csv",
    "/analytics/history.csv",
  ])("serves CSV export under documented alias %s", async (url) => {
    const app = await buildTestServer();
    try {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(response.headers["content-disposition"]).toBe(
        'attachment; filename="alice-tip-history.csv"',
      );
    } finally {
      await app.close();
    }
  });
});
