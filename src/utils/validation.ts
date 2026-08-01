/**
 * utils/validation.ts
 *
 * Shared Zod refinements and schema primitives used across route validators.
 */

import { z } from "zod";

/**
 * Validates a URL that:
 *   - Is a well-formed URL (Zod's built-in .url() check)
 *   - Uses the `https:` scheme exclusively
 *
 * Rejects `http:`, `javascript:`, `data:`, `file:`, and any other scheme.
 *
 * Host allowlisting is intentionally left to the frontend (next.config.mjs
 * `remotePatterns`) so the backend doesn't need to be updated when new
 * image CDNs are added. The `https:` requirement is the security boundary.
 *
 * @example
 * // Accepted
 * "https://cdn.example.com/avatar.png"
 * "https://api.dicebear.com/7.x/identicon/svg?seed=alice"
 *
 * // Rejected
 * "http://cdn.example.com/avatar.png"   // non-https
 * "javascript:alert(1)"                 // XSS vector
 * "data:image/png;base64,..."           // data URI
 * "file:///etc/passwd"                  // local file
 */
export const httpsUrl = z
  .string()
  .url({ message: "Must be a valid URL." })
  .refine(
    (val) => {
      try {
        return new URL(val).protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Avatar URL must use the https: scheme." },
  );
