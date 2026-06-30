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
 * Stellar keypairs use — so no Stellar SDK dependency is needed here.
 */

import nacl from "tweetnacl";
import { randomBytes } from "crypto";
import { setAuthNonce, consumeAuthNonce } from "../../redis.js";
import { db } from "../../db.js";
import { isValidAccountId } from "@novatip/sdk";

// ── Challenge ─────────────────────────────────────────────────────────────────

/**
 * Generate a random nonce and store it in Redis against the wallet address.
 * The nonce expires after 5 minutes (enforced by Redis TTL).
 */
export async function generateChallenge(walletAddress: string): Promise<string> {
  if (!isValidAccountId(walletAddress)) {
    throw Object.assign(new Error("Invalid Stellar account address."), { statusCode: 400 });
  }

  const nonce = randomBytes(32).toString("hex");
  await setAuthNonce(walletAddress, nonce);
  return nonce;
}

// ── Verify ────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  jwt: string;
  isNewUser: boolean;
}

/**
 * Verify a signed challenge and return a JWT.
 *
 * @param walletAddress - G... Stellar account address
 * @param signatureHex  - Hex-encoded Ed25519 signature over the nonce bytes
 * @param publicKeyHex  - Hex-encoded 32-byte Ed25519 public key matching the address
 */
export async function verifyChallenge(
  walletAddress: string,
  signatureHex: string,
  publicKeyHex: string,
  signJwt: (payload: object) => string,
): Promise<VerifyResult> {
  if (!isValidAccountId(walletAddress)) {
    throw Object.assign(new Error("Invalid Stellar account address."), { statusCode: 400 });
  }

  // Retrieve and consume the nonce (single-use)
  const nonce = await consumeAuthNonce(walletAddress);
  if (!nonce) {
    throw Object.assign(
      new Error("Challenge not found or expired. Request a new challenge."),
      { statusCode: 401 },
    );
  }

  // Verify Ed25519 signature
  const valid = verifyEd25519(nonce, signatureHex, publicKeyHex);
  if (!valid) {
    throw Object.assign(new Error("Signature verification failed."), { statusCode: 401 });
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

  const creator = await db.creator.findUniqueOrThrow({ where: { walletAddress } });

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
function verifyEd25519(
  nonce: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const message   = Buffer.from(nonce, "utf8");
    const signature = Buffer.from(signatureHex, "hex");
    const publicKey = Buffer.from(publicKeyHex, "hex");

    if (publicKey.length !== 32) return false;
    if (signature.length !== 64) return false;

    return nacl.sign.detached.verify(
      new Uint8Array(message),
      new Uint8Array(signature),
      new Uint8Array(publicKey),
    );
  } catch {
    return false;
  }
}
