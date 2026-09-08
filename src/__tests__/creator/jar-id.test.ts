/**
 * __tests__/creator/jar-id.test.ts
 *
 * Covers the slug → jarId mapping used by claimSlug.
 *
 * The regression under test: claimSlug stored whatever jarId the client sent,
 * and the route schema only required a non-empty string. A mismatched pair
 * produced a creator whose public page is at /alice while the on-chain jar is
 * "@bob" — and the indexer resolves tips by jarId, so those tips either land
 * against the wrong creator's page or never resolve at all.
 */

import { jarIdForSlug, resolveJarId } from "../../modules/creator/jar-id.js";

// ── Derivation ────────────────────────────────────────────────────────────────

describe("jarIdForSlug", () => {
  test.each([
    ["alice", "@alice"],
    ["bob-the-builder", "@bob-the-builder"],
    ["snake_case", "@snake_case"],
    ["user123", "@user123"],
  ])("maps %s to %s", (slug, expected) => {
    expect(jarIdForSlug(slug)).toBe(expected);
  });
});

describe("resolveJarId", () => {
  describe("derives the jar id when the client omits it", () => {
    test("omitted entirely", () => {
      expect(resolveJarId("alice")).toBe("@alice");
    });

    test("passed as an explicit undefined", () => {
      // The route spreads a parsed zod body, so an absent optional field
      // arrives as a present-but-undefined property rather than a missing one.
      expect(resolveJarId("alice", undefined)).toBe("@alice");
    });
  });

  // ── The frontend's existing call ───────────────────────────────────────────

  test("accepts the matching jarId novatip-web already sends", () => {
    expect(resolveJarId("alice", "@alice")).toBe("@alice");
  });

  // ── The regression ─────────────────────────────────────────────────────────

  describe("rejects a mismatched slug/jarId pair", () => {
    const mismatches: Array<[string, string, string]> = [
      ["a different creator's jar", "alice", "@bob"],
      ["the slug with no @ prefix", "alice", "alice"],
      ["a differently-cased jar", "alice", "@Alice"],
      ["a jar with trailing whitespace", "alice", "@alice "],
      ["a double-prefixed jar", "alice", "@@alice"],
      ["an empty string", "alice", ""],
      ["a jar for a slug that merely starts the same", "alice", "@alice2"],
    ];

    test.each(mismatches)("rejects %s", (_label, slug, jarId) => {
      expect(() => resolveJarId(slug, jarId)).toThrow();
    });

    test.each(mismatches)("rejects %s with a 400, not a 500", (_label, slug, jarId) => {
      // claimSlug's callers surface thrown errors through the global handler,
      // which falls back to 500 for anything without a statusCode. A bad
      // request from the client must not read as a server fault.
      try {
        resolveJarId(slug, jarId);
        throw new Error("expected resolveJarId to throw");
      } catch (err) {
        expect(err).toHaveProperty("statusCode", 400);
      }
    });

    test("names the expected jarId so the client can correct itself", () => {
      expect(() => resolveJarId("alice", "@bob")).toThrow('jarId must be "@alice"');
    });
  });

  // ── Never silently rewritten ───────────────────────────────────────────────

  test("does not quietly coerce a mismatch into the derived value", () => {
    // Returning "@alice" here would hide the fact that the caller registered
    // "@bob" on-chain — the tips would still be unroutable, just without a
    // failure anyone could see.
    let returned: string | undefined;
    try {
      returned = resolveJarId("alice", "@bob");
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });
});
