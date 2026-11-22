/**
 * notifications/webhook-failure.service.ts
 *
 * Tells a creator a registered webhook is failing, as a WEBHOOK_FAILED
 * Notification row.
 *
 * Before this, a dead receiver only showed up in the WebhookDelivery history
 * a creator had to think to go check — a webhook could be down for a week and
 * the creator would never hear about it. The enum value and the table already
 * existed for this; nothing wrote to them.
 *
 * One tip can reach several enabled webhooks, and an indexer that redelivers
 * (or a receiver that is down for days) can mean many failed tips against the
 * same broken endpoint. Without suppression that is one row per tip, which
 * drowns the one thing worth telling the creator — "this endpoint is down" —
 * in duplicates of itself. So at most one row is written per webhook per
 * SUPPRESS_WINDOW_MS, counted from the last one actually written rather than
 * from the first failure, which is what keeps a receiver that is down for a
 * week to a handful of rows instead of one per tip.
 */

import { db } from "../../db.js";
import { logger } from "../../utils/logger.js";

const failureLogger = logger.child({ component: "notifications:webhook-failure" });

/** At most one WEBHOOK_FAILED row per webhook within this span. */
const SUPPRESS_WINDOW_MS = 60 * 60 * 1000;

export interface WebhookFailure {
  webhookId: string;
  url: string;
  statusCode: number | null;
}

/**
 * Record a WEBHOOK_FAILED notification for `creatorId`, unless one already
 * exists for the same webhook within the suppression window.
 *
 * Called from the dispatch path on every failed delivery, so it never
 * throws: a notification failing to write must not stop the delivery loop,
 * and dispatch itself must not stop the indexer. Errors are logged and
 * swallowed here for the same reason sendTipNotification swallows its own.
 */
export async function notifyWebhookFailure(
  creatorId: string,
  failure: WebhookFailure,
): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - SUPPRESS_WINDOW_MS);

    // Scoped to the creator and the type, then matched against the specific
    // webhook in application code — simpler than a JSON-path query, and the
    // result set is bounded by the window regardless.
    const recent = await db.notification.findMany({
      where: {
        creatorId,
        type: "WEBHOOK_FAILED",
        createdAt: { gte: cutoff },
      },
      select: { payload: true },
    });

    const alreadyNotified = recent.some(
      (row) =>
        (row.payload as unknown as { webhookId?: string }).webhookId ===
        failure.webhookId,
    );
    if (alreadyNotified) return;

    await db.notification.create({
      data: {
        creatorId,
        type: "WEBHOOK_FAILED",
        payload: {
          webhookId: failure.webhookId,
          url: failure.url,
          statusCode: failure.statusCode,
        },
      },
    });
  } catch (err) {
    failureLogger.error(
      { err, webhookId: failure.webhookId },
      "failed to record webhook-failure notification",
    );
  }
}
