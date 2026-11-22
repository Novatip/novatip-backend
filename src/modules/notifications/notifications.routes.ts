/**
 * notifications.routes.ts
 *
 * GET /api/v1/notifications - creator notification feed (auth)
 * POST /api/v1/notifications/read - mark notifications as read (auth)
 * GET  /api/v1/notifications/preferences — read channel flags (auth required)
 * PATCH /api/v1/notifications/preferences — switch either channel (auth required)
 *
 * novatip-web's Notification preferences card reads and writes
 * { preferences: { emailEnabled, webhookEnabled } }; it previously 404'd
 * because this module registered no routes.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
  listNotifications,
  markNotificationsRead,
  markAllNotificationsRead,
} from "./notifications.service.js";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "./preferences.service.js";

export const NotificationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_NOTIFICATION_PAGE_SIZE)
    .default(DEFAULT_NOTIFICATION_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
  unread: z
    .enum(["true", "false"])
    .transform((val) => val === "true")
    .optional(),
  cursor: z.string().min(1).optional(),
});

/**
 * The body mirrors the response envelope, so one shape describes both
 * directions of the card's traffic. Either flag may be omitted to leave its
 * channel unchanged; a *present* flag must be a boolean — "true" or 1 from
 * a misbehaving client is a 400 naming the field, not a write of a value
 * Postgres would coerce. Same reasoning as EnabledBody in webhooks.routes.
 */
const PreferencesBody = z.object({
  preferences: z.object({
    emailEnabled: z.boolean().optional(),
    webhookEnabled: z.boolean().optional(),
  }),
});

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  // Every route here reads or writes the signed-in creator's own data.
  app.addHook("onRequest", app.authenticate);

  // ── GET / ──────────────────────────────────────────────────────────────────
  app.get("/", async (request, reply) => {
    const query = NotificationQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    const { user } = request;
    const page = await listNotifications(
      user.sub,
      query.data.limit,
      query.data.offset,
      query.data.unread ?? false,
      query.data.cursor ?? null,
    );

    return reply.send(page);
  });

  // ── GET /preferences ──────────────────────────────────────────────────────
  app.get("/preferences", async (request, reply) => {
    const preferences = await getNotificationPreferences(request.user.sub);
    return reply.send({ preferences });
  });

  // ── PATCH /preferences ────────────────────────────────────────────────────
  app.patch("/preferences", async (request, reply) => {
    const body = PreferencesBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const preferences = await updateNotificationPreferences(
      request.user.sub,
      body.data.preferences,
    );
    return reply.send({ preferences });
  });
};
