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

import nacl from "tweetnacl";
import { createHash, randomBytes } from "crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { setAuthNonce, consumeAuthNonce } from "../../redis.js";
import { db } from "../../db.js";
import { isValidAccountId } from "@novatip/sdk";

// ── Challenge ─────────────────────────────────────────────────────────────────

/**
 * Generate a random nonce and store it in Redis against the wallet address.
 * The nonce expires after 5 minutes (enforced by Redis TTL).
 */
export async function generateChallenge(
  walletAddress: string,
): Promise<string> {
  if (!isValidAccountId(walletAddress)) {
    throw Object.assign(new Error("Invalid Stellar account address."), {
      statusCode: 400,
    });
  }

  const nonce = randomBytes(32).toString("hex");
  await setAuthNonce(walletAddress, nonce);
  return nonce;
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
 * @param walletAddress - G... Stellar account address
 * @param signatureHex  - Hex-encoded Ed25519 signature over the nonce bytes
 */
export async function verifyChallenge(
  walletAddress: string,
  signatureHex: string,
  signJwt: (payload: SessionClaims) => string,
): Promise<VerifyResult> {
  if (!isValidAccountId(walletAddress)) {
    throw Object.assign(new Error("Invalid Stellar account address."), {
      statusCode: 400,
    });
  }

  // Retrieve and consume the nonce (single-use)
  const nonce = await consumeAuthNonce(walletAddress);
  if (!nonce) {
    throw Object.assign(
      new Error("Challenge not found or expired. Request a new challenge."),
      { statusCode: 401 },
    );
  }

  // The public key is derived from walletAddress itself rather than taken from
  // the client, so there is no separate value that could name a different key
  // than the one the signature is checked against.
  const publicKey = StrKey.decodeEd25519PublicKey(walletAddress);

  // Verify Ed25519 signature
  const valid = verifyEd25519(nonce, signatureHex, publicKey);
  if (!valid) {
    throw Object.assign(new Error("Signature verification failed."), {
      statusCode: 401,
    });
  }

  // Upsert creator record (wallet address is the identity anchor)
  const existing = await db.creator.findUnique({ where: { walletAddress } });
  const isNewUser = !existing;

  if (isNewUser) {
    // New user — create a bare record; they'll claim a slug in onboarding
    await db.creator.create({
      data: {
        walletAddress,
        slug: `user_${randomBytes(4).toString("hex")}`, // temporary slug
        jarId: `@user_${randomBytes(4).toString("hex")}`,
      },
    });
  }

  const creator = await db.creator.findUniqueOrThrow({
    where: { walletAddress },
  });

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
 * Verify a signature over the challenge nonce.
 *
 * Two payloads are accepted, and both prove the same thing — that the holder
 * of this account's key signed this specific single-use nonce:
 *
 *   1. The SEP-53 digest. This is what Freighter's signMessage and every other
 *      SEP-53 wallet produces, and it is the path the browser actually uses.
 *      Verifying only the raw bytes is why wallet sign-in never worked.
 *   2. The raw nonce bytes, for scripts and tests that sign with a keypair
 *      directly rather than through a wallet.
 */
function verifyEd25519(
  nonce: string,
  signatureHex: string,
  publicKey: Buffer,
): boolean {
  try {
    const signature = Buffer.from(signatureHex, "hex");

    if (publicKey.length !== 32) return false;
    if (signature.length !== 64) return false;

    const key = new Uint8Array(publicKey);
    const sig = new Uint8Array(signature);

    const candidates = [sep53Digest(nonce), Buffer.from(nonce, "utf8")];
    return candidates.some((payload) =>
      nacl.sign.detached.verify(new Uint8Array(payload), sig, key),
    );
  } catch {
    return false;
  }
}
