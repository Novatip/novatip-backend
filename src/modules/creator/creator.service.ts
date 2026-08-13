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

import type { Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { cacheInvalidate, cacheGet, cacheSet } from "../../redis.js";

const SLUG_REGEX = /^[a-z0-9_-]{3,32}$/;
const PROFILE_CACHE_TTL = 60; // seconds

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The public-facing creator shape returned by getCreatorBySlug.
 * Matches the `select` in that query exactly — both the cache and
 * database branches must conform to this type.
 */
export interface PublicCreator {
  id:          string;
  slug:        string;
  displayName: string | null;
  bio:         string | null;
  avatarUrl:   string | null;
  jarId:       string;
  splits:      Prisma.JsonValue;
  createdAt:   Date;
}

// The `| undefined` on each optional field is deliberate. The tsconfig enables
// exactOptionalPropertyTypes, and these are built by spreading a parsed zod
// body whose absent fields are present-but-undefined — so the properties have
// to admit undefined explicitly, not merely be optional.
export interface ClaimSlugInput {
  creatorId: string;
  slug: string;
  /** On-chain jar ID — must match slug, e.g. "@alice" */
  jarId: string;
  displayName?: string | undefined;
  bio?: string | undefined;
  splits?: Array<{ to: string; bps: number }> | undefined;
}

export interface UpdateProfileInput {
  creatorId: string;
  displayName?: string | undefined;
  bio?: string | undefined;
  avatarUrl?: string | undefined;
}

// ── Slug claim ────────────────────────────────────────────────────────────────

/**
 * Claim a slug for an authenticated creator.
 * Fails if the slug is already taken or invalid.
 */
export async function claimSlug(input: ClaimSlugInput) {
  if (!SLUG_REGEX.test(input.slug)) {
    throw Object.assign(
      new Error("Slug must be 3–32 characters: lowercase letters, numbers, hyphens, underscores."),
      { statusCode: 400 },
    );
  }

  // Check availability
  const existing = await db.creator.findUnique({ where: { slug: input.slug } });
  if (existing && existing.id !== input.creatorId) {
    throw Object.assign(new Error("This slug is already taken."), { statusCode: 409 });
  }

  const creator = await db.creator.update({
    where: { id: input.creatorId },
    // Optional fields are spread in only when supplied. Prisma reads a missing
    // key as "leave unchanged", but exactOptionalPropertyTypes rejects passing
    // an explicit undefined to say the same thing.
    data: {
      slug:   input.slug,
      jarId:  input.jarId,
      splits: input.splits ?? [],
      ...(input.displayName !== undefined && { displayName: input.displayName }),
      ...(input.bio !== undefined && { bio: input.bio }),
    },
  });

  await cacheInvalidate(`creator:${input.slug}`);
  return creator;
}

// ── Profile ───────────────────────────────────────────────────────────────────

/**
 * Get a public creator profile by slug.
 * Result is cached in Redis for 60 seconds.
 */
export async function getCreatorBySlug(slug: string): Promise<PublicCreator> {
  const cacheKey = `creator:${slug}`;
  const cached = await cacheGet<PublicCreator>(cacheKey);
  if (cached) return cached;

  const creator = await db.creator.findUnique({
    where: { slug },
    select: {
      id:          true,
      slug:        true,
      displayName: true,
      bio:         true,
      avatarUrl:   true,
      jarId:       true,
      splits:      true,
      createdAt:   true,
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
      ...(input.displayName !== undefined && { displayName: input.displayName }),
      ...(input.bio !== undefined && { bio: input.bio }),
      ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
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
  const existing = await db.creator.findUnique({ where: { slug } });
  return !existing;
}
