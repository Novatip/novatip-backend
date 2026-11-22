/**
 * auth.service.ts
 *
 * Sign-In With Stellar (SIWS) authentication.
 *
 * Flow:
 *   1. Client calls POST /auth/challenge  → receives a one-time nonce
 *   2. Client signs the nonce with their Stellar private key (Ed25519)
 *   3. Client calls POST /auth/verify     → receives a JWT on success
 *
 * Signature verification uses TweetNaCl (Ed25519) — the same curve
 * Stellar keypairs use. The Stellar SDK is only used to decode the walletAddress
 * strkey into its raw public key bytes.
 */

import { Prisma, type Creator } from "@prisma/client";
import nacl from "tweetnacl";
import { createHash, randomBytes } from "crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { setAuthNonce, consumeAuthNonce } from "../../redis.js";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { isValidAccountId } from "@novatip/sdk";
import { jarIdForSlug } from "../creator/jar-id.js";

/** Maximum attempts to generate an uncollided temporary slug/jarId for new creators. */
export const MAX_CREATOR_CREATE_ATTEMPTS = 5;

/** Strict UTC ISO-8601 format produced by Date.prototype.toISOString(). */
const ISO_8601_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** First-line format produced by generateChallenge, rejecting spaces, slashes, and userinfo. */
const CHALLENGE_DOMAIN_LINE_REGEX =
  /^([^\s/@]+) wants you to sign in with your Stellar account:$/;

/**
 * Stable error codes emitted by the authentication service:
 * - INVALID_ACCOUNT (400): walletAddress is not a valid Stellar G... account ID
 * - CHALLENGE_NOT_FOUND (401): no active nonce in Redis for this wallet
 * - DOMAIN_MISMATCH (401): challenge first line does not match configured domain
 * - NONCE_MISSING (401): signed message does not contain the expected nonce
 * - INVALID_EXPIRY (401): Expires At line is missing, repeated, or malformed
 * - CHALLENGE_EXPIRED (401): challenge timestamp is in the past
 * - SIGNATURE_INVALID (401): Ed25519 signature verification failed
 * - AUTH_DOMAIN_NOT_CONFIGURED (500): APP_BASE_URL is missing or invalid
 */
export type AuthErrorCode =
  | "INVALID_ACCOUNT"
  | "CHALLENGE_NOT_FOUND"
  | "DOMAIN_MISMATCH"
  | "NONCE_MISSING"
  | "INVALID_EXPIRY"
  | "CHALLENGE_EXPIRED"
  | "SIGNATURE_INVALID"
  | "AUTH_DOMAIN_NOT_CONFIGURED";

function authError(
  statusCode: number,
  code: AuthErrorCode,
  message: string,
): Error & { statusCode: number; code: AuthErrorCode } {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Derive the expected challenge domain (host[:port], lowercased) from config.appBaseUrl.
 * Fails safe with a 500 error if APP_BASE_URL is missing or invalid.
 */
export function getExpectedAuthDomain(): string {
  try {
    const url = new URL(config.appBaseUrl);
    if (!url.host) {
      throw new Error("Empty host");
    }
    return url.host.toLowerCase();
  } catch {
    throw authError(
      500,
      "AUTH_DOMAIN_NOT_CONFIGURED",
      "Server authentication domain is not configured.",
    );
  }
}

// ── Challenge ─────────────────────────────────────────────────────────────────

export interface ChallengeMessage {
  message: string;
  nonce: string;
}

/**
 * Generate a domain-bound challenge message and store the nonce in Redis.
 * The nonce expires after 5 minutes (enforced by Redis TTL).
 */
export async function generateChallenge(
  walletAddress: string,
  domain: string = getExpectedAuthDomain(),
): Promise<ChallengeMessage> {
  if (!isValidAccountId(walletAddress)) {
    throw authError(400, "INVALID_ACCOUNT", "Invalid Stellar account address.");
  }

  const nonce = randomBytes(32).toString("hex");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const message = `${domain} wants you to sign in with your Stellar account:\n${walletAddress}\n\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpires At: ${expiresAt}`;

  await setAuthNonce(walletAddress, nonce);
  return { message, nonce };
}

// ── Verify ────────────────────────────────────────────────────────────────────

/**
 * Claims embedded in a creator session token. Must stay in step with the
 * FastifyJWT payload augmentation in src/types/fastify.d.ts.
 */
export interface SessionClaims {
  sub: string;
  wallet: string;
  slug: string;
}

export interface VerifyResult {
  jwt: string;
  isNewUser: boolean;
}

/**
 * Verify a signed challenge and return a JWT.
 *
 * Nonces are single-use: `consumeAuthNonce` burns the stored challenge
 * immediately upon retrieval before signature verification. Consuming the nonce
 * on any attempt (success or failure) prevents replay attacks, ensuring an
 * attacker cannot intercept and reuse a nonce after a failed attempt. Because
 * any failed verification consumes the challenge, the client must request a new
 * challenge before attempting verification again.
 *
 * @param walletAddress - G... Stellar account address
 * @param signedMessage - The full signed message text
 * @param signatureHex  - Hex-encoded Ed25519 signature over the message
 */
export async function verifyChallenge(
  walletAddress: string,
  signedMessage: string,
  signatureHex: string,
  signJwt: (payload: SessionClaims) => string,
): Promise<VerifyResult> {
  if (!isValidAccountId(walletAddress)) {
    throw authError(400, "INVALID_ACCOUNT", "Invalid Stellar account address.");
  }

  const nonce = await consumeAuthNonce(walletAddress);
  if (!nonce) {
    throw authError(
      401,
      "CHALLENGE_NOT_FOUND",
      "Challenge not found or expired. Request a new challenge.",
    );
  }

  const expectedDomain = getExpectedAuthDomain();
  const firstLine = signedMessage.split(/\r?\n/, 1)[0] ?? "";
  const domainMatch = CHALLENGE_DOMAIN_LINE_REGEX.exec(firstLine);
  if (!domainMatch || domainMatch[1]!.toLowerCase() !== expectedDomain) {
    throw authError(
      401,
      "DOMAIN_MISMATCH",
      "Message domain does not match this server.",
    );
  }

  if (!signedMessage.includes(`Nonce: ${nonce}`)) {
    throw authError(
      401,
      "NONCE_MISSING",
      "Message does not contain expected nonce.",
    );
  }

  const expiresLines = signedMessage
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Expires At:"));
  if (expiresLines.length !== 1) {
    throw authError(
      401,
      "INVALID_EXPIRY",
      "Challenge message has an invalid expiry.",
    );
  }
  const expiresLine = expiresLines[0]!;
  if (!expiresLine.startsWith("Expires At: ")) {
    throw authError(
      401,
      "INVALID_EXPIRY",
      "Challenge message has an invalid expiry.",
    );
  }
  const expiresRaw = expiresLine.slice("Expires At: ".length);
  const expiresAtMs = ISO_8601_UTC_REGEX.test(expiresRaw)
    ? Date.parse(expiresRaw)
    : Number.NaN;
  if (
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== expiresRaw
  ) {
    throw authError(
      401,
      "INVALID_EXPIRY",
      "Challenge message has an invalid expiry.",
    );
  }
  if (Date.now() > expiresAtMs) {
    throw authError(401, "CHALLENGE_EXPIRED", "Challenge message has expired.");
  }

  const publicKey = StrKey.decodeEd25519PublicKey(walletAddress);

  const valid = verifyEd25519(signedMessage, signatureHex, publicKey);
  if (!valid) {
    throw authError(
      401,
      "SIGNATURE_INVALID",
      "Signature verification failed. Request a new challenge.",
    );
  }

  // Resolve creator record (wallet address is the identity anchor)
  let creator = await db.creator.findUnique({ where: { walletAddress } });
  const isNewUser = !creator;

  if (!creator) {
    // New user — create a bare record; they'll claim a slug in onboarding.
    // Temporary slug generation can collide, so retry on unique constraint violations up to a bounded limit.
    let created: Creator | null = null;
    for (let attempt = 0; attempt < MAX_CREATOR_CREATE_ATTEMPTS; attempt++) {
      try {
        const slug = `user_${randomBytes(4).toString("hex")}`;
        created = await db.creator.create({
          data: {
            walletAddress,
            slug,
            jarId: jarIdForSlug(slug),
          },
        });
        break;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          // If a concurrent request won the race to create the creator for this walletAddress,
          // retrieve the existing record so the duplicate request succeeds cleanly rather than
          // throwing a 500 on what is an ordinary double-click (#87).
          const target = (err.meta as { target?: unknown })?.target;
          const isWalletConflict =
            (Array.isArray(target) && target.includes("walletAddress")) ||
            target === "walletAddress";

          if (isWalletConflict) {
            const existing = await db.creator.findUnique({
              where: { walletAddress },
            });
            if (existing) {
              created = existing;
              break;
            }
          }

          // Otherwise the collision was on temporary slug/jarId — retry with a new suffix.
          if (attempt < MAX_CREATOR_CREATE_ATTEMPTS - 1) {
            continue;
          }
        }
        throw err;
      }
    }

    if (!created) {
      throw new Error("Failed to create creator record.");
    }
    creator = created;
  }

  const token = signJwt({
    sub: creator.id,
    wallet: walletAddress,
    slug: creator.slug,
  });

  return { jwt: token, isNewUser };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify an Ed25519 signature over a UTF-8 nonce string.
 * Returns true only if signature is valid.
 */
/**
 * SEP-53 message prefix. Wallets sign
 * `SHA256("Stellar Signed Message:\n" + message)` rather than the raw bytes,
 * so that a signed message can never be mistaken for a signed transaction.
 */
const SEP53_PREFIX = "Stellar Signed Message:\n";

/** The digest a SEP-53 wallet actually signs for a given message. */
function sep53Digest(message: string): Buffer {
  const encoded = Buffer.concat([
    Buffer.from(SEP53_PREFIX, "utf8"),
    Buffer.from(message, "utf8"),
  ]);
  return createHash("sha256").update(encoded).digest();
}

/**
 * Verify a signature over the challenge message using SEP-53.
 */
function verifyEd25519(
  message: string,
  signatureHex: string,
  publicKey: Buffer,
): boolean {
  try {
    const signature = Buffer.from(signatureHex, "hex");

    if (publicKey.length !== 32) return false;
    if (signature.length !== 64) return false;

    const key = new Uint8Array(publicKey);
    const sig = new Uint8Array(signature);
    const payload = sep53Digest(message);

    return nacl.sign.detached.verify(new Uint8Array(payload), sig, key);
  } catch {
    return false;
  }
}
