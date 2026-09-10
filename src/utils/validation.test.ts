/**
 * validation.test.ts
 *
 * Tests for shared Zod validators in utils/validation.ts.
 * Focus: httpsUrl — ensures only https: scheme URLs are accepted.
 */

import { httpsUrl } from "./validation.js";

// ── httpsUrl ──────────────────────────────────────────────────────────────────

describe("httpsUrl", () => {
  // ── Accepted ───────────────────────────────────────────────────────────────

  describe("accepts valid https URLs", () => {
    const valid = [
      "https://cdn.example.com/avatar.png",
      "https://api.dicebear.com/7.x/identicon/svg?seed=alice",
      "https://novatip.xyz/images/avatar.jpg",
      "https://images.unsplash.com/photo-123?w=400",
      // Uppercase scheme — URL constructor normalises it to https:
      "HTTPS://cdn.example.com/avatar.png",
    ];

    test.each(valid)("accepts %s", (url) => {
      expect(httpsUrl.safeParse(url).success).toBe(true);
    });
  });

  // ── Rejected — dangerous schemes ──────────────────────────────────────────

  describe("rejects javascript: URIs (XSS vector)", () => {
    const cases = [
      "javascript:alert(1)",
      "javascript:void(0)",
      "javascript://comment%0Aalert(1)",
    ];

    test.each(cases)("rejects %s", (url) => {
      const result = httpsUrl.safeParse(url);
      expect(result.success).toBe(false);
    });
  });

  describe("rejects data: URIs", () => {
    const cases = [
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
      "data:text/html,<h1>hi</h1>",
      "data:application/javascript,alert(1)",
    ];

    test.each(cases)("rejects %s", (url) => {
      const result = httpsUrl.safeParse(url);
      expect(result.success).toBe(false);
    });
  });

  describe("rejects file: URIs", () => {
    const cases = [
      "file:///etc/passwd",
      "file://localhost/etc/hosts",
      "file:///C:/Windows/System32/config/SAM",
    ];

    test.each(cases)("rejects %s", (url) => {
      const result = httpsUrl.safeParse(url);
      expect(result.success).toBe(false);
    });
  });

  // ── Rejected — non-https http ──────────────────────────────────────────────

  describe("rejects plain http: URLs", () => {
    const cases = [
      "http://cdn.example.com/avatar.png",
      "http://api.dicebear.com/7.x/identicon/svg",
    ];

    test.each(cases)("rejects %s", (url) => {
      const result = httpsUrl.safeParse(url);
      expect(result.success).toBe(false);
    });
  });

  // ── Rejected — other schemes ───────────────────────────────────────────────

  describe("rejects other non-https schemes", () => {
    const cases = [
      "ftp://example.com/avatar.png",
      "blob:https://example.com/some-id",
      "ws://example.com/socket",
      "wss://example.com/socket",
    ];

    test.each(cases)("rejects %s", (url) => {
      const result = httpsUrl.safeParse(url);
      expect(result.success).toBe(false);
    });
  });

  // ── Rejected — malformed / empty ──────────────────────────────────────────

  describe("rejects malformed or empty values", () => {
    const cases = [
      "",
      "not-a-url",
      "//cdn.example.com/avatar.png", // protocol-relative
      "cdn.example.com/avatar.png", // no scheme
    ];

    test.each(cases)("rejects %s", (url) => {
      const result = httpsUrl.safeParse(url);
      expect(result.success).toBe(false);
    });
  });

  // ── Error messages ─────────────────────────────────────────────────────────

  describe("error messages", () => {
    it("reports a clear message for a non-https scheme", () => {
      const result = httpsUrl.safeParse("http://example.com/img.png");
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain("Avatar URL must use the https: scheme.");
      }
    });

    it("reports a URL validation message for completely malformed input", () => {
      const result = httpsUrl.safeParse("not-a-url");
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain("Must be a valid URL.");
      }
    });
  });
});
