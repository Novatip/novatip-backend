/**
 * __tests__/creator/reserved-slugs.test.ts
 *
 * Verifies that RESERVED_SLUGS lives in a pure module with no config.js or
 * db.js side effects (#365), so standalone scripts such as
 * scripts/check-reserved-slugs.ts can import it with only DATABASE_URL set.
 */

import { RESERVED_SLUGS } from "../../modules/creator/reserved-slugs.js";

describe("RESERVED_SLUGS (#365)", () => {
  it("loads without requiring app config or database environment variables", () => {
    expect(RESERVED_SLUGS).toBeInstanceOf(Set);
    expect(RESERVED_SLUGS.size).toBeGreaterThan(0);
  });

  it("includes static frontend routes and impersonation-sensitive slugs", () => {
    for (const slug of [
      "api",
      "admin",
      "dashboard",
      "onboarding",
      "settings",
      "_next",
      "novatip",
    ]) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });
});
