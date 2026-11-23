/**
 * creator/reserved-slugs.ts
 *
 * Slugs that can't be claimed by a creator, kept as a standalone pure module.
 *
 * It lives here rather than in creator.service.ts so standalone scripts (like
 * scripts/check-reserved-slugs.ts) and unit tests can import it without
 * pulling in db.js or config.js, which require the full env config at module
 * load.
 *
 * novatip-web serves creator pages from src/app/[slug]/page.tsx, at the same
 * routing level as static routes like /dashboard and /onboarding. Next.js
 * resolves static segments before dynamic ones, so a creator claiming one of
 * those slugs would get a page permanently shadowed by the app's own route.
 * api and _next are reserved for the same routing reason; admin/support/etc
 * are reserved to prevent impersonation.
 *
 * Exported as a single constant so claimSlug, isSlugAvailable, and
 * check-reserved-slugs.ts can't drift apart on what's reserved.
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
