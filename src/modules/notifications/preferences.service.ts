/**
 * notifications/preferences.service.ts
 *
 * Notification channel preferences stored on the creator: whether tip
 * emails and tip webhooks are switched on. Backs the web app's
 * Notification preferences card via notifications.routes.ts.
 *
 * The flags are read/write only through these functions — the dispatch
 * services keep their existing gates (email: an address must be present;
 * webhooks: per-webhook enabled rows) and are intentionally untouched here.
 */

import { db } from "../../db.js";

export interface NotificationPreferences {
  emailEnabled: boolean;
  webhookEnabled: boolean;
}

/**
 * The `| undefined` on each optional field is deliberate. The tsconfig
 * enables exactOptionalPropertyTypes, and PATCH bodies arrive with absent
 * keys meaning "leave unchanged" — the properties have to admit undefined
 * explicitly, not merely be optional. Same pattern as ClaimSlugInput in
 * creator.service.ts.
 */
export interface UpdateNotificationPreferencesInput {
  emailEnabled?: boolean | undefined;
  webhookEnabled?: boolean | undefined;
}

/**
 * Read a creator's channel preferences.
 *
 * The `select` is an allowlist for the same reason getCreatorBySlug's is
 * (see the note there): an authenticated endpoint returning a purpose-built
 * shape rather than a raw row, so private columns such as email can't leak
 * by accident.
 */
export async function getNotificationPreferences(
  creatorId: string,
): Promise<NotificationPreferences> {
  const creator = await db.creator.findUnique({
    where: { id: creatorId },
    select: { emailEnabled: true, webhookEnabled: true },
  });

  if (!creator) {
    throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
  }

  return creator;
}

/**
 * Update either or both channel flags and return the resulting pair.
 *
 * Absent keys mean "leave unchanged" — a PATCH naming one channel must not
 * silently rewrite the other, and Prisma reads a missing key the same way
 * (see the same note in creator.service's updateProfile).
 */
export async function updateNotificationPreferences(
  creatorId: string,
  input: UpdateNotificationPreferencesInput,
): Promise<NotificationPreferences> {
  // Check that the creator exists first, throwing a 404 if not. This matches
  // getNotificationPreferences's behavior and prevents a Prisma P2025 error
  // (record not found) from falling through as a generic 500.
  const existing = await db.creator.findUnique({
    where: { id: creatorId },
    select: { id: true },
  });

  if (!existing) {
    throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
  }

  return db.creator.update({
    where: { id: creatorId },
    data: {
      ...(input.emailEnabled !== undefined && {
        emailEnabled: input.emailEnabled,
      }),
      ...(input.webhookEnabled !== undefined && {
        webhookEnabled: input.webhookEnabled,
      }),
    },
    select: { emailEnabled: true, webhookEnabled: true },
  });
}
