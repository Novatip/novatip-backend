/**
 * __tests__/notifications/mark-read-route.test.ts
 *
 * Tests for POST /api/v1/notifications/read endpoint, exercising the route
 * end-to-end with app.inject rather than calling the service directly.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";
import { db } from "../../db.js";
import { notificationRoutes } from "../../modules/notifications/notifications.routes.js";

describe("POST /notifications/read", () => {
  let app: FastifyInstance;
  let creatorId: string;
  let otherCreatorId: string;
  let token: string;
  let otherToken: string;
  let notificationIds: string[];

  beforeEach(async () => {
    app = Fastify();
    await app.register(jwtPlugin, {
      secret: process.env["JWT_SECRET"] || "test-secret-at-least-32-chars-long-123456",
    });

    // Mock authenticate
    app.decorate("authenticate", async (request: any) => {
      await request.jwtVerify();
    });

    await app.register(notificationRoutes, { prefix: "/notifications" });

    // Create test creators
    const creator = await db.creator.create({
      data: {
        walletAddress: "GMARKREAD1",
        slug: "markreadtest",
        jarId: "@markreadtest",
      },
    });
    creatorId = creator.id;
    token = app.jwt.sign({ sub: creatorId });

    const otherCreator = await db.creator.create({
      data: {
        walletAddress: "GMARKREAD2",
        slug: "othermarkread",
        jarId: "@othermarkread",
      },
    });
    otherCreatorId = otherCreator.id;
    otherToken = app.jwt.sign({ sub: otherCreatorId });

    // Create test notifications
    const n1 = await db.notification.create({
      data: {
        creatorId,
        type: "TIP_RECEIVED",
        payload: { amount: "10000000" },
      },
    });

    const n2 = await db.notification.create({
      data: {
        creatorId,
        type: "TIP_RECEIVED",
        payload: { amount: "20000000" },
      },
    });

    const n3 = await db.notification.create({
      data: {
        creatorId,
        type: "WEBHOOK_FAILED",
        payload: { webhookId: "test" },
      },
    });

    notificationIds = [n1.id, n2.id, n3.id];
  });

  afterEach(async () => {
    await app.close();
  });

  it("should mark specific notifications as read", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/notifications/read",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        notificationIds: [notificationIds[0], notificationIds[1]],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.markedRead).toBe(2);

    // Verify the notifications were marked read
    const n1 = await db.notification.findUnique({ where: { id: notificationIds[0] } });
    const n2 = await db.notification.findUnique({ where: { id: notificationIds[1] } });
    const n3 = await db.notification.findUnique({ where: { id: notificationIds[2] } });

    expect(n1?.readAt).not.toBeNull();
    expect(n2?.readAt).not.toBeNull();
    expect(n3?.readAt).toBeNull();
  });

  it("should mark all notifications as read", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/notifications/read",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        all: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.markedRead).toBe(3);

    // Verify all notifications were marked read
    const notifications = await db.notification.findMany({
      where: { creatorId },
    });

    expect(notifications.every((n) => n.readAt !== null)).toBe(true);
  });

  it("should not mark another creator's notifications", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/notifications/read",
      headers: {
        authorization: `Bearer ${otherToken}`,
      },
      payload: {
        notificationIds: [notificationIds[0], notificationIds[1]],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.markedRead).toBe(0);

    // Verify the notifications were NOT marked read
    const n1 = await db.notification.findUnique({ where: { id: notificationIds[0] } });
    const n2 = await db.notification.findUnique({ where: { id: notificationIds[1] } });

    expect(n1?.readAt).toBeNull();
    expect(n2?.readAt).toBeNull();
  });

  it("should require either notificationIds or all", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/notifications/read",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject both notificationIds and all", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/notifications/read",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        notificationIds: [notificationIds[0]],
        all: true,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should require authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/notifications/read",
      payload: {
        all: true,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should handle empty notificationIds array", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/notifications/read",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        notificationIds: [],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 0 when marking already-read notifications", async () => {
    // First, mark them read
    await app.inject({
      method: "POST",
      url: "/notifications/read",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        all: true,
      },
    });

    // Try to mark them read again
    const response = await app.inject({
      method: "POST",
      url: "/notifications/read",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        notificationIds: [notificationIds[0], notificationIds[1]],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.markedRead).toBe(0);
  });
});
