/**
 * messages.service.ts
 *
 * Service for managing tip message visibility.
 * Creators can hide abusive or spam messages from their public tip feed.
 */

import { db } from "../../db.js";
import { cacheInvalidatePrefix } from "../../redis.js";

/**
 * Set the messageHidden flag for a tip.
 * Returns null if the tip does not exist or doesn't belong to the creator.
 */
export async function setTipMessageHidden(
  creatorId: string,
  tipId: string,
  hidden: boolean,
): Promise<{ id: string; messageHidden: boolean } | null> {
  const { count } = await db.tip.updateMany({
    where: { id: tipId, creatorId },
    data: { messageHidden: hidden },
  });

  if (count === 0) return null;

  const tip = await db.tip.findUnique({
    where: { id: tipId },
    select: { id: true, messageHidden: true },
  });

  // Invalidate both the creator's private recent-tips cache and the public
  // feed cache across all limits and cursors.
  await cacheInvalidatePrefix(`analytics:recent:${creatorId}:`);

  const creator = await db.creator.findUnique({
    where: { id: creatorId },
    select: { slug: true },
  });

  if (creator) {
    await cacheInvalidatePrefix(`analytics:public-recent:${creator.slug}:`);
  }

  return tip;
}
