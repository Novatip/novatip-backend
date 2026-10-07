/**
 * webhooks/limit.ts
 *
 * Cap on how many webhooks one creator may register.
 *
 * dispatchWebhooks fans out to every enabled endpoint on every indexed tip,
 * each with its own five second timeout and its own WebhookDelivery row. With
 * no cap, one tip turns into an unbounded amount of outbound work inside the
 * indexer's event handling — a cost problem, and the easiest way to make
 * indexing slow without touching the chain at all.
 *
 * The decision is split out from the service so it can be reasoned about (and
 * tested) without a database: the service supplies the current count, this
 * module decides whether another registration is allowed.
 */

import { config } from "../../config.js";

/** error.code on the rejection, so clients can branch on it. */
export const WEBHOOK_LIMIT_CODE = "WEBHOOK_LIMIT_REACHED";

/**
 * The configured cap, or null when registration is unlimited.
 *
 * MAX_WEBHOOKS_PER_CREATOR=0 removes the cap, matching the convention the
 * retention windows already use for "no limit".
 */
export function webhookLimit(): number | null {
  const limit = config.webhooks.maxPerCreator;
  return limit > 0 ? limit : null;
}

/**
 * Throw a 409 when `existingCount` already fills the cap.
 *
 * The count is of all of the creator's webhooks, enabled or not: a disabled
 * row is still a row the creator can flip back on, so excluding them would
 * make the cap trivial to walk around.
 *
 * The message names both the number and the env var that sets it — an
 * operator reading it in a client's logs should not have to go looking for
 * where the limit came from.
 */
export function assertWebhookLimit(
  existingCount: number,
  limit: number | null = webhookLimit(),
): void {
  if (limit === null || existingCount < limit) return;

  throw Object.assign(
    new Error(
      `Webhook limit reached: a creator may register at most ${limit} ` +
        `webhook${limit === 1 ? "" : "s"} (MAX_WEBHOOKS_PER_CREATOR). ` +
        `Delete an existing webhook before registering another.`,
    ),
    { statusCode: 409, code: WEBHOOK_LIMIT_CODE },
  );
}
