/**
 * __tests__/notifications/notifications-routes.test.ts
 *
 * Tests for GET /notifications query parameter handling and response shape.
 * Covers issues found where:
 * - unread and cursor query params were parsed but never forwarded
 * - response was double-nested under {notifications: {notifications: [...]}}
 */

import { jest } from "@jest/globals";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import jwtPlugin from "@fastify/jwt";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR = "creator_notif";
const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

interface FakeNotification {
  id: string;
  type: "TIP_RECEIVED" | "WEBHOOK_FAILED";
  payload: Record<string, unknown> | unknown[] | null;
  sent: boolean;
  sentAt: Date | null;
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
  creatorId: string;
}

let notifications: FakeNotification[] = [];

const findManyMock = jest.fn(
  async (args: {
    where: Record<string, unknown>;
    orderBy: unknown[];
    take: number;
    skip: number;
    select: Record<string, boolean>;
  }) => {
    let filtered = notifications.filter((n) => n.creatorId === args.where.creatorId);
    
    // Apply unread filter if specified
    if (args.where.readAt === null) {
      filtered = filtered.filter((n) => n.readAt === null);
    }
    
    // Apply cursor pagination if specified
    const cursorWhere = args.where.OR;
    if (Array.isArray(cursorWhere) && cursorWhere.length > 0) {
      // Simple cursor simulation - filter by createdAt < cursor timestamp
      const cursorCondition = cursorWhere[0];
      if (cursorCondition && "createdAt" in cursorCondition && "lt" in cursorCondition.createdAt) {
        const cursorTimestamp = cursorCondition.createdAt.lt as Date;
        filtered = filtered.filter((n) => n.createdAt < cursorTimestamp);
      }
    }

    // Sort by createdAt desc, id desc
    filtered.sort((a, b) => {
      const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.id.localeCompare(a.id);
    });

    // Apply offset and limit
    const start = args.skip;
    const end = start + args.take;
    return filtered.slice(start, end);
  },
);

const countMock = jest.fn(async (args: { where: Record<string, unknown> }) => {
  return notifications.filter(
    (n) =>
      n.creatorId === args.where.creatorId &&
      (args.where.readAt === null ? n.readAt === null : true),
  ).length;
});

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    notification: {
      findMany: findManyMock,
      count: countMock,
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: async (): Promise<null> => null,
  cacheSet: async (): Promise<void> => undefined,
  cacheInvalidate: async (): Promise<void> => undefined,
}));

const { notificationRoutes } =
  await import("../../modules/notifications/notifications.routes.js");

let app: FastifyInstance;

function authHeaders(): { authorization: string } {
  const token = app.jwt.sign({ sub: CREATOR, wallet: WALLET, slug: "notif" });
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  jest.clearAllMocks();
  
  // Create some test notifications
  const baseTime = new Date("2024-01-01T12:00:00Z");
  notifications = [
    {
      id: "notif_1",
      type: "TIP_RECEIVED",
      payload: { amount: "10000000" },
      sent: true,
      sentAt: new Date(baseTime.getTime() + 1000),
      read: false,
      readAt: null,
      createdAt: new Date(baseTime.getTime() + 5000),
      creatorId: CREATOR,
    },
    {
      id: "notif_2",
      type: "TIP_RECEIVED",
      payload: { amount: "20000000" },
      sent: true,
      sentAt: new Date(baseTime.getTime() + 2000),
      read: true,
      readAt: new Date(baseTime.getTime() + 3000),
      createdAt: new Date(baseTime.getTime() + 4000),
      creatorId: CREATOR,
    },
    {
      id: "notif_3",
      type: "WEBHOOK_FAILED",
      payload: { error: "timeout" },
      sent: false,
      sentAt: null,
      read: false,
      readAt: null,
      createdAt: new Date(baseTime.getTime() + 3000),
      creatorId: CREATOR,
    },
    {
      id: "notif_4",
      type: "TIP_RECEIVED",
      payload: { amount: "30000000" },
      sent: true,
      sentAt: new Date(baseTime.getTime()),
      read: false,
      readAt: null,
      createdAt: new Date(baseTime.getTime() + 2000),
      creatorId: CREATOR,
    },
  ];

  app = Fastify();
  await app.register(jwtPlugin, {
    secret: "test-secret-at-least-32-chars-long-123456",
  });
  app.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch {
        reply.status(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required.",
          },
        });
      }
    },
  );
  await app.register(notificationRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ── Response shape ────────────────────────────────────────────────────────────

describe("GET / response shape", () => {
  test("returns a flat structure with notifications, unreadCount, nextCursor", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    
    // Should be flat, not nested under {notifications: {notifications: [...]}}
    expect(body).toHaveProperty("notifications");
    expect(body).toHaveProperty("unreadCount");
    expect(body).toHaveProperty("nextCursor");
    
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(typeof body.unreadCount).toBe("number");
    expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true);
  });

  test("notifications array contains properly shaped items with read fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: authHeaders(),
    });

    const body = res.json();
    expect(body.notifications.length).toBeGreaterThan(0);
    
    const notification = body.notifications[0];
    expect(notification).toHaveProperty("id");
    expect(notification).toHaveProperty("type");
    expect(notification).toHaveProperty("payload");
    expect(notification).toHaveProperty("sent");
    expect(notification).toHaveProperty("sentAt");
    expect(notification).toHaveProperty("read");
    expect(notification).toHaveProperty("readAt");
    expect(notification).toHaveProperty("createdAt");
  });

  test("unreadCount reflects the total number of unread notifications", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: authHeaders(),
    });

    const body = res.json();
    // 3 notifications have readAt: null in our test data
    expect(body.unreadCount).toBe(3);
  });
});

// ── Query parameter: unread ───────────────────────────────────────────────────

describe("GET / with ?unread=true", () => {
  test("filters to only unread notifications", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?unread=true",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    
    expect(body.notifications.length).toBe(3); // notif_1, notif_3, notif_4
    expect(body.notifications.every((n: { readAt: unknown }) => n.readAt === null)).toBe(true);
    expect(body.unreadCount).toBe(3); // Total unread count stays the same
  });

  test("?unread=false returns all notifications", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?unread=false",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    
    expect(body.notifications.length).toBe(4); // All notifications
  });

  test("omitting unread returns all notifications", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    
    expect(body.notifications.length).toBe(4);
  });
});

// ── Query parameter: cursor ───────────────────────────────────────────────────

describe("GET / with ?cursor", () => {
  test("advances the page when cursor is provided", async () => {
    // First page
    const res1 = await app.inject({
      method: "GET",
      url: "/?limit=2",
      headers: authHeaders(),
    });

    const body1 = res1.json();
    expect(body1.notifications.length).toBe(2);
    expect(body1.nextCursor).toBeTruthy();
    
    const firstPageIds = body1.notifications.map((n: { id: string }) => n.id);

    // Second page using cursor
    const res2 = await app.inject({
      method: "GET",
      url: `/?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: authHeaders(),
    });

    const body2 = res2.json();
    expect(body2.notifications.length).toBeGreaterThan(0);
    
    const secondPageIds = body2.notifications.map((n: { id: string }) => n.id);
    
    // Pages should not overlap
    const overlap = firstPageIds.filter((id: string) => secondPageIds.includes(id));
    expect(overlap.length).toBe(0);
  });

  test("nextCursor is null when there are no more results", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?limit=100",
      headers: authHeaders(),
    });

    const body = res.json();
    expect(body.nextCursor).toBeNull();
  });

  test("nextCursor is provided when more results exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?limit=2",
      headers: authHeaders(),
    });

    const body = res.json();
    expect(body.notifications.length).toBe(2);
    expect(body.nextCursor).not.toBeNull();
    expect(typeof body.nextCursor).toBe("string");
  });
});

// ── Combined parameters ───────────────────────────────────────────────────────

describe("GET / with combined parameters", () => {
  test("?unread=true works with cursor pagination", async () => {
    // First page of unread
    const res1 = await app.inject({
      method: "GET",
      url: "/?unread=true&limit=2",
      headers: authHeaders(),
    });

    const body1 = res1.json();
    expect(body1.notifications.length).toBe(2);
    expect(body1.notifications.every((n: { readAt: unknown }) => n.readAt === null)).toBe(true);
    
    if (body1.nextCursor) {
      // Second page of unread
      const res2 = await app.inject({
        method: "GET",
        url: `/?unread=true&limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers: authHeaders(),
      });

      const body2 = res2.json();
      expect(body2.notifications.every((n: { readAt: unknown }) => n.readAt === null)).toBe(true);
    }
  });

  test("respects limit parameter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?limit=2",
      headers: authHeaders(),
    });

    const body = res.json();
    expect(body.notifications.length).toBe(2);
  });

  test("respects offset parameter", async () => {
    const res1 = await app.inject({
      method: "GET",
      url: "/",
      headers: authHeaders(),
    });
    const allIds = res1.json().notifications.map((n: { id: string }) => n.id);

    const res2 = await app.inject({
      method: "GET",
      url: "/?offset=1",
      headers: authHeaders(),
    });

    const offsetIds = res2.json().notifications.map((n: { id: string }) => n.id);
    expect(offsetIds).toEqual(allIds.slice(1));
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("GET / validation", () => {
  test("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
  });

  test("rejects invalid limit", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?limit=0",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  test("rejects limit over maximum", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?limit=101",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  test("rejects negative offset", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?offset=-1",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });
});
