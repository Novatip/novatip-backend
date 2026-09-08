/**
 * creator/jar-id.ts
 *
 * The slug → jar ID mapping, kept as a standalone pure module.
 *
 * It lives here rather than in creator.service.ts so it can be unit tested
 * directly: importing the service pulls in db.js, which constructs a Prisma
 * client and requires the full env config at module load.
 */

/**
 * The on-chain jar ID for a slug. The "@" belongs to the jar ID, not to the
 * web URL — see the tip-URL note in the README.
 */
export function jarIdForSlug(slug: string): string {
  return `@${slug}`;
}

/**
 * Resolve the jar ID to store for a claim.
 *
 * The value is derived from the slug rather than taken from the request, so a
 * creator whose web slug and on-chain jar disagree is unrepresentable. The
 * indexer resolves tips by jarId, and a mismatch there means tips either land
 * against a creator whose public page lives at a different address or never
 * resolve at all.
 *
 * A caller may still send jarId — novatip-web does — but it must match. An
 * explicit mismatch is rejected rather than quietly overwritten: the caller
 * registered that jar on-chain, so disagreeing with them is a real error on
 * one side or the other, and silently picking a winner hides it.
 */
export function resolveJarId(slug: string, jarId?: string | undefined): string {
  const expected = jarIdForSlug(slug);

  if (jarId !== undefined && jarId !== expected) {
    throw Object.assign(
      new Error(`jarId must be "${expected}" to match the claimed slug.`),
      { statusCode: 400 },
    );
  }

  return expected;
}
