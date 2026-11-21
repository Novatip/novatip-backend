/**
 * creator.service.ts
 *
 * Business logic for creator profiles and slug claiming.
 *
 * A creator must:
 *   1. Be authenticated (wallet-based JWT)
 *   2. Claim a unique public slug (e.g. "alice" → /@alice tip page)
 *   3. Register that slug as a jar on-chain (done client-side via the SDK;
 *      backend just records the claimed slug + jarId)
 */

import { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { config } from "../../config.js";
import {
  cacheInvalidate,
  cacheGet,
  cacheSet,
  revokeCreatorTokens,
} from "../../redis.js";
import { resolveJarId } from "./jar-id.js";
import { CREATOR_SLUG_REGEX } from "../../utils/validation.js";

// Re-exported so callers keep importing the creator API from one place.
export { jarIdForSlug, resolveJarId } from "./jar-id.js";

/**
 * The sign-in placeholder every new wallet starts on: auth.service mints
 * `user_${randomBytes(4).toString("hex")}` — user_ plus 8 hex chars — and
 * claiming is what turns it into a real slug. claimSlug uses this as the
 * definition of "hasn't claimed yet" (see the one-claim guard there); the
 * format is pinned to auth.service's generation on purpose, so a creator who
 * somehow holds anything else — even a near-miss like user_1234abc — counts
 * as having claimed and must go through renameSlug.
 *
 * Exported so placeholder-retention.ts uses the exact same definition when
 * deciding which creators are still unclaimed sign-in placeholders.
 */
export const PLACEHOLDER_SLUG_REGEX = /^user_[0-9a-f]{8}$/;
/**
 * How long a public profile stays in the Redis cache. Exported so the
 * resolver's Cache-Control max-age matches it — a browser or CDN holding a
 * response longer than the server would only serve staler data.
 */
export const PROFILE_CACHE_TTL = 60; // seconds
const MILLIS_PER_DAY = 86_400_000;

/**
 * Slugs that can't be claimed by a creator.
 *
 * novatip-web serves creator pages from src/app/[slug]/page.tsx, at the same
 * routing level as static routes like /dashboard and /onboarding. Next.js
 * resolves static segments before dynamic ones, so a creator claiming one of
 * those slugs would get a page permanently shadowed by the app's own route.
 * api and _next are reserved for the same routing reason; admin/support/etc
 * are reserved to prevent impersonation.
 *
 * Exported as a single constant so claimSlug and isSlugAvailable can't drift
 * apart on what's reserved.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "admin",
  "dashboard",
  "onboarding",
  "settings",
  "login",
  "logout",
  "auth",
  "support",
  "help",
  "about",
  "terms",
  "privacy",
  "static",
  "_next",
  "novatip",
]);

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The public-facing creator shape returned by getCreatorBySlug.
 * Matches the `select` in that query exactly — both the cache and
 * database branches must conform to this type.
 */
export interface PublicCreator {
  id: string;
  slug: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  jarId: string;
  splits: Prisma.JsonValue;
  createdAt: Date;
}

// The `| undefined` on each optional field is deliberate. The tsconfig enables
// exactOptionalPropertyTypes, and these are built by spreading a parsed zod
// body whose absent fields are present-but-undefined — so the properties have
// to admit undefined explicitly, not merely be optional.
export interface ClaimSlugInput {
  creatorId: string;
  slug: string;
  /**
   * On-chain jar ID, e.g. "@alice". Optional: the stored value is always
   * derived from the slug (see resolveJarId). Supplying it is supported for
   * clients that already registered the jar on-chain and want the mismatch
   * caught rather than silently overridden.
   */
  jarId?: string | undefined;
  displayName?: string | undefined;
  bio?: string | undefined;
  splits?: Array<{ to: string; bps: number }> | undefined;
}

export interface UpdateProfileInput {
  creatorId: string;
  /**
   * `null` clears it, same reasoning as `email` below — an absent key means
   * "leave unchanged", and a creator removing their display name, bio or
   * avatar needs a way to take it back rather than being stuck with
   * whatever they last set.
   */
  displayName?: string | null | undefined;
  bio?: string | null | undefined;
  avatarUrl?: string | null | undefined;
  /**
   * Contact address for tip notifications. `null` clears it — a creator who
   * changes their mind needs a way to take the address back, and an absent
   * key already means "leave unchanged".
   */
  email?: string | null | undefined;
}

// ── Slug holds ────────────────────────────────────────────────────────────────

/**
 * When a hold on a released slug lapses: the release plus the configured
 * window (CREATOR_SLUG_HOLD_DAYS, default 90 days). Purely a function of
 * releasedAt, so an expired row is inert — nothing needs to prune it for the
 * slug to become free again.
 */
function heldUntil(release: { releasedAt: Date }): Date {
  return new Date(
    release.releasedAt.getTime() +
      config.creators.slugHoldDays * MILLIS_PER_DAY,
  );
}

/**
 * The release row behind an *active* hold on `slug`, or null when the slug
 * was never released or the window has elapsed.
 *
 * A released slug used to be free the instant its owner renamed away from
 * it, so whoever claimed next inherited every stale link, printed poster and
 * QR code still pointing at it — and showed their own wallet to the people
 * who meant to tip the original creator. The hold closes that gap for
 * everyone but that previous owner, who is exempted by the caller.
 */
async function activeSlugHold(slug: string) {
  const released = await db.releasedSlug.findUnique({ where: { slug } });
  if (!released) return null;
  if (Date.now() >= heldUntil(released).getTime()) return null;
  return released;
}

/**
 * Throw when `slug` sits behind an active hold that `requesterId` doesn't
 * own. Deliberately the same 409 SLUG_TAKEN shape as an occupied slug: to
 * every caller but the previous owner the slug *is* taken, and clients
 * already handle that one conflict. The message says what is going on.
 */
async function assertSlugHoldFree(slug: string, requesterId: string) {
  const hold = await activeSlugHold(slug);
  if (!hold || hold.previousOwnerId === requesterId) return;

  throw Object.assign(
    new Error(
      "This slug was released by its previous owner and is on hold until " +
        `${heldUntil(hold).toISOString().slice(0, 10)} — ` +
        "only they can take it until then.",
    ),
    { statusCode: 409, code: "SLUG_TAKEN" },
  );
}

/**
 * Record that `previousOwnerId` let go of `slug`, starting (or restarting)
 * its hold window. An upsert: the table is keyed by slug, so a slug that is
 * released → reclaimed → released again must end up with one row carrying
 * the latest release rather than colliding on a second one.
 */
async function recordSlugRelease(
  slug: string,
  previousOwnerId: string,
): Promise<void> {
  const releasedAt = new Date();
  await db.releasedSlug.upsert({
    where: { slug },
    create: { slug, previousOwnerId, releasedAt },
    update: { previousOwnerId, releasedAt },
  });
}

// ── Slug claim ────────────────────────────────────────────────────────────────

/**
 * Claim a slug for an authenticated creator.
 * Fails if the slug is already taken, invalid, or held for a previous owner,
 * or if this creator already holds a real slug (409 ALREADY_CLAIMED — the
 * claim is the one-time transition off the sign-in placeholder).
 */
export async function claimSlug(input: ClaimSlugInput) {
  if (!CREATOR_SLUG_REGEX.test(input.slug)) {
    throw Object.assign(
      new Error(
        "Slug must be 3–32 characters: lowercase letters, numbers, hyphens, underscores.",
      ),
      { statusCode: 400 },
    );
  }

  if (RESERVED_SLUGS.has(input.slug)) {
    throw Object.assign(
      new Error(`"${input.slug}" is a reserved slug and can't be claimed.`),
      { statusCode: 400 },
    );
  }

  const jarId = resolveJarId(input.slug, input.jarId);

  // Which slug, if any, this claim is about to release. First-time claimants
  // have none; a creator switching slugs here releases the old one exactly
  // as renameSlug does, so the hold follows the claim too.
  const current = await db.creator.findUnique({
    where: { id: input.creatorId },
  });

  // Check availability. This pre-check handles the common case, but two
  // requests can race and both pass it before either writes — the unique
  // constraint below is what actually prevents a duplicate.
  const existing = await db.creator.findUnique({ where: { slug: input.slug } });
  if (existing && existing.id !== input.creatorId) {
    throw Object.assign(new Error("This slug is already taken."), {
      statusCode: 409,
      code: "SLUG_TAKEN",
    });
  }

  // Free of creators ≠ free: the slug may still be held for whoever last
  // released it (previous owner excepted).
  await assertSlugHoldFree(input.slug, input.creatorId);

  // The claimant's own eligibility, checked last so the target-slug errors
  // above keep precedence — a claim naming an occupied slug still reads
  // SLUG_TAKEN rather than this. But with the target checks satisfied, a
  // caller already on a real slug is refused: a claim is the one-time move
  // off the sign-in placeholder (PLACEHOLDER_SLUG_REGEX), and a second one
  // would point slug and jarId at values the contract has never seen — the
  // jar registered on-chain under the old id is orphaned and tips to the new
  // one fail JarNotFound — while also resetting splits to []. Switching
  // slugs is renameSlug's job. A distinct code from SLUG_TAKEN: nothing is
  // taken here, the caller has simply already claimed.
  if (current && !PLACEHOLDER_SLUG_REGEX.test(current.slug)) {
    throw Object.assign(
      new Error(
        "You have already claimed a slug — each creator claims once. " +
          "To change it, rename via PATCH /creators/me/slug instead.",
      ),
      { statusCode: 409, code: "ALREADY_CLAIMED" },
    );
  }

  let creator;
  try {
    creator = await db.creator.update({
      where: { id: input.creatorId },
      data: {
        slug: input.slug,
        jarId,
        splits: input.splits ?? [],
        ...(input.displayName !== undefined && {
          displayName: input.displayName,
        }),
        ...(input.bio !== undefined && { bio: input.bio }),
      },
    });
  } catch (err) {
    throw toClaimConflict(err);
  }

  await db.tip.updateMany({
    where: {
      jarId,
      creatorId: null,
    },
    data: {
      creatorId: creator.id,
    },
  });

  if (current && current.slug !== input.slug) {
    await recordSlugRelease(current.slug, input.creatorId);
  }

  await cacheInvalidate(`creator:${input.slug}`);
  return creator;
}

export interface RenameSlugInput {
  creatorId: string;
  slug: string;
}

/**
 * Rename a creator's public slug.
 *
 * Reuses what claimSlug enforces:
 * - Slug pattern (3–32 lowercase letters, numbers, hyphens, underscores)
 * - Reserved slug list
 * - Availability pre-check and unique constraint conflict handling (409)
 * - The hold on a slug released by someone else (409; exempt for its
 *   previous owner, who may rename back to their old slug)
 *
 * Leaves jarId and splits untouched: on-chain jar remains registered under
 * its original jarId, changing only where the tip page resolves.
 * Records the slug left behind as released — that record is what starts the
 * hold — and invalidates the resolver cache for both the old and new slug.
 */
export async function renameSlug(input: RenameSlugInput) {
  if (!CREATOR_SLUG_REGEX.test(input.slug)) {
    throw Object.assign(
      new Error(
        "Slug must be 3–32 characters: lowercase letters, numbers, hyphens, underscores.",
      ),
      { statusCode: 400 },
    );
  }

  if (RESERVED_SLUGS.has(input.slug)) {
    throw Object.assign(
      new Error(`"${input.slug}" is a reserved slug and can't be claimed.`),
      { statusCode: 400 },
    );
  }

  const current = await db.creator.findUnique({
    where: { id: input.creatorId },
  });
  if (!current) {
    throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
  }

  const oldSlug = current.slug;

  const existing = await db.creator.findUnique({ where: { slug: input.slug } });
  if (existing && existing.id !== input.creatorId) {
    throw Object.assign(new Error("This slug is already taken."), {
      statusCode: 409,
      code: "SLUG_TAKEN",
    });
  }

  // Renaming to a slug someone else released recently: held for them until
  // the window lapses (renaming back to your own old slug is not).
  await assertSlugHoldFree(input.slug, input.creatorId);

  let creator;
  try {
    creator = await db.creator.update({
      where: { id: input.creatorId },
      data: {
        slug: input.slug,
      },
    });
  } catch (err) {
    throw toClaimConflict(err);
  }

  // The slug just left behind is the one the hold protects. Recorded after
  // the write so a rename that never landed doesn't hold anything.
  if (input.slug !== oldSlug) {
    await recordSlugRelease(oldSlug, input.creatorId);
  }

  await cacheInvalidate(`creator:${oldSlug}`);
  if (input.slug !== oldSlug) {
    await cacheInvalidate(`creator:${input.slug}`);
  }

  return creator;
}

/**
 * Remove a creator profile and its private account-owned records while keeping
 * indexed tips as unattributed financial history. The schema sets tip creator
 * references to null when the creator is deleted; webhook delivery records and
 * notifications are explicitly deleted before their parent records.
 */
export async function deleteCreator(creatorId: string): Promise<void> {
  const slug = await db.$transaction(async (tx) => {
    const creator = await tx.creator.findUnique({
      where: { id: creatorId },
      select: { slug: true },
    });
    if (!creator) {
      throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
    }

    await tx.notification.deleteMany({ where: { creatorId } });

    const webhooks = await tx.webhook.findMany({
      where: { creatorId },
      select: { id: true },
    });
    const webhookIds = webhooks.map(({ id }) => id);

    if (webhookIds.length > 0) {
      await tx.webhookDelivery.deleteMany({
        where: { webhookId: { in: webhookIds } },
      });
    }

    await tx.webhook.deleteMany({ where: { creatorId } });
    await tx.releasedSlug.upsert({
      where: { slug: creator.slug },
      create: {
        slug: creator.slug,
        previousOwnerId: null,
        releasedAt: new Date(),
      },
      update: { previousOwnerId: null, releasedAt: new Date() },
    });
    await tx.creator.delete({ where: { id: creatorId } });

    return creator.slug;
  });

  await revokeCreatorTokens(creatorId);
  await cacheInvalidate(`creator:${slug}`);
}

/**
 * A losing concurrent claim hits the DB's unique constraint (slug and jarId
 * are both @unique) as Prisma error P2002, not the pre-check above. That
 * reaches the global error handler with no statusCode and surfaces as a 500
 * — this rethrows it as the same 409 the pre-check produces, using
 * err.meta.target to say which column conflicted.
 */
function toClaimConflict(err: unknown): unknown {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== "P2002"
  ) {
    return err;
  }

  const target = err.meta?.["target"];
  const conflictsOnJarId = Array.isArray(target) && target.includes("jarId");

  return Object.assign(
    new Error(
      conflictsOnJarId
        ? "This jarId is already registered to another creator."
        : "This slug is already taken.",
    ),
    { statusCode: 409, code: conflictsOnJarId ? "JARID_TAKEN" : "SLUG_TAKEN" },
  );
}

// ── Profile ───────────────────────────────────────────────────────────────────

/**
 * Get a public creator profile by slug.
 * Result is cached in Redis for 60 seconds.
 *
 * The `select` below is an allowlist, not a convenience: it is what keeps
 * private columns — email in particular — out of the public creator endpoint,
 * the resolver that reuses this function, and the Redis cache. Add a field
 * here only if it is meant to be world-readable.
 */
export async function getCreatorBySlug(slug: string): Promise<PublicCreator> {
  const cacheKey = `creator:${slug}`;
  const cached = await cacheGet<PublicCreator>(cacheKey);
  if (cached) return cached;

  const creator = await db.creator.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      displayName: true,
      bio: true,
      avatarUrl: true,
      jarId: true,
      splits: true,
      createdAt: true,
    },
  });

  if (!creator) {
    throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
  }

  await cacheSet(cacheKey, creator, PROFILE_CACHE_TTL);
  return creator;
}

/**
 * Update an authenticated creator's profile fields.
 */
export async function updateProfile(input: UpdateProfileInput) {
  const current =
    input.email === undefined
      ? null
      : await db.creator.findUnique({
          where: { id: input.creatorId },
          select: { email: true },
        });
  if (input.email !== undefined && !current) {
    throw Object.assign(new Error("Creator not found."), { statusCode: 404 });
  }

  const creator = await db.creator.update({
    where: { id: input.creatorId },
    // See the note in claimSlug: absent key, not an explicit undefined.
    data: {
      ...(input.displayName !== undefined && {
        displayName: input.displayName,
      }),
      ...(input.bio !== undefined && { bio: input.bio }),
      ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
      ...(input.email !== undefined && {
        email: input.email,
        ...(input.email !== current?.email && { emailVerifiedAt: null }),
      }),
    },
  });

  await cacheInvalidate(`creator:${creator.slug}`);
  return creator;
}

/**
 * Update the on-chain splits stored on the creator's profile.
 * Called after the creator successfully calls update_splits on-chain.
 */
export async function updateCreatorSplits(
  creatorId: string,
  splits: Array<{ to: string; bps: number }>,
) {
  const creator = await db.creator.update({
    where: { id: creatorId },
    data: { splits },
  });

  await cacheInvalidate(`creator:${creator.slug}`);
  return creator;
}

/**
 * Check if a slug is available (no auth required).
 *
 * `viewerId` is the authenticated caller when there is one: a held slug reads
 * unavailable to everyone except `viewerId` being its previous owner, matching
 * what claim and rename will let that creator do.
 */
export async function isSlugAvailable(
  slug: string,
  viewerId?: string,
): Promise<boolean> {
  if (!CREATOR_SLUG_REGEX.test(slug)) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  const existing = await db.creator.findUnique({ where: { slug } });
  if (existing) return false;
  const hold = await activeSlugHold(slug);
  if (hold && hold.previousOwnerId !== viewerId) return false;

  const jarId = resolveJarId(slug);
  const jarOwner = await db.creator.findUnique({ where: { jarId } });
  if (jarOwner && jarOwner.id !== viewerId) return false;

  return true;
}
