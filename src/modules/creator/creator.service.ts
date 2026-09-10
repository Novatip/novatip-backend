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
import { cacheInvalidate, cacheGet, cacheSet } from "../../redis.js";
import { resolveJarId } from "./jar-id.js";

// Re-exported so callers keep importing the creator API from one place.
export { jarIdForSlug, resolveJarId } from "./jar-id.js";

const SLUG_REGEX = /^[a-z0-9_-]{3,32}$/;
const PROFILE_CACHE_TTL = 60; // seconds

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
  displayName?: string | undefined;
  bio?: string | undefined;
  avatarUrl?: string | undefined;
  /**
   * Contact address for tip notifications. `null` clears it — a creator who
   * changes their mind needs a way to take the address back, and an absent
   * key already means "leave unchanged".
   */
  email?: string | null | undefined;
}

// ── Slug claim ────────────────────────────────────────────────────────────────

/**
 * Claim a slug for an authenticated creator.
 * Fails if the slug is already taken or invalid.
 */
export async function claimSlug(input: ClaimSlugInput) {
  if (!SLUG_REGEX.test(input.slug)) {
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

  let creator;
  try {
    creator = await db.creator.update({
      where: { id: input.creatorId },
      // Optional fields are spread in only when supplied. Prisma reads a missing
      // key as "leave unchanged", but exactOptionalPropertyTypes rejects passing
      // an explicit undefined to say the same thing.
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

  await cacheInvalidate(`creator:${input.slug}`);
  return creator;
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
  const creator = await db.creator.update({
    where: { id: input.creatorId },
    // See the note in claimSlug: absent key, not an explicit undefined.
    data: {
      ...(input.displayName !== undefined && {
        displayName: input.displayName,
      }),
      ...(input.bio !== undefined && { bio: input.bio }),
      ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
      ...(input.email !== undefined && { email: input.email }),
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
 */
export async function isSlugAvailable(slug: string): Promise<boolean> {
  if (!SLUG_REGEX.test(slug)) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  const existing = await db.creator.findUnique({ where: { slug } });
  return !existing;
}
