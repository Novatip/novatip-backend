/**
 * notifications.service.ts
 *
 * Reads the creator's stored notifications and presents them in an API-safe
 * shape, newest first, with cursor-based pagination to avoid offset-shift problems.
 */

import { db } from "../../db.js";
import { encodeCursor, decodeCursor, cursorFilter } from "../../utils/cursor.js";

export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20;
export const MAX_NOTIFICATION_PAGE_SIZE = 100;

export interface NotificationRecord {
  id: string;
  type: "TIP_RECEIVED" | "WEBHOOK_FAILED";
  payload: Record<string, unknown> | unknown[] | null;
  sent: boolean;
  sentAt: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  notifications: NotificationRecord[];
  unreadCount: number;
  nextCursor: string | null;
}

export async function listNotifications(
  creatorId: string,
  limit = DEFAULT_NOTIFICATION_PAGE_SIZE,
  offset = 0,
  unreadOnly = false,
  cursor?: string | null,
): Promise<NotificationPage> {
  const take = Math.min(Math.max(limit, 1), MAX_NOTIFICATION_PAGE_SIZE);

  const after = cursor ? decodeCursor(cursor) : null;

  const where = unreadOnly
    ? { creatorId, readAt: null, ...(after ? cursorFilter(after, "createdAt", "id") : {}) }
    : { creatorId, ...(after ? cursorFilter(after, "createdAt", "id") : {}) };

  const [rows, unreadCount] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      skip: cursor ? 0 : offset,
      select: {
        id: true,
        type: true,
        payload: true,
        sentAt: true,
        readAt: true,
        createdAt: true,
      },
    }),
    db.notification.count({ where: { creatorId, readAt: null } }),
  ]);

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page[page.length - 1];

  return {
    notifications: page.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload as Record<string, unknown> | unknown[] | null,
      sent: row.sentAt !== null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      read: row.readAt !== null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    })),
    unreadCount,
    nextCursor:
      hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/**
 * Mark specific notifications as read.
 * Only updates notifications belonging to the creator.
 */
export async function markNotificationsRead(
  creatorId: string,
  notificationIds: string[],
): Promise<number> {
  const { count } = await db.notification.updateMany({
    where: {
      id: { in: notificationIds },
      creatorId,
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  return count;
}

/**
 * Mark all of a creator's notifications as read.
 */
export async function markAllNotificationsRead(
  creatorId: string,
): Promise<number> {
  const { count } = await db.notification.updateMany({
    where: {
      creatorId,
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  return count;
}
