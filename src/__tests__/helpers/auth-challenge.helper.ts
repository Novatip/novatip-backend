/**
 * __tests__/helpers/auth-challenge.helper.ts
 *
 * Shared helper for building and SEP-53 signing SIWS challenge messages in tests.
 */

import { createHash } from "crypto";
import type { Keypair } from "@stellar/stellar-sdk";

const SEP53_PREFIX = "Stellar Signed Message:\n";

export function sep53Digest(message: string): Buffer {
  const encoded = Buffer.concat([
    Buffer.from(SEP53_PREFIX, "utf8"),
    Buffer.from(message, "utf8"),
  ]);
  return createHash("sha256").update(encoded).digest();
}

export interface BuildChallengeMessageOptions {
  domain?: string;
  walletAddress: string;
  nonce: string;
  issuedAt?: string;
  expiresAt?: string;
}

export function buildChallengeMessage({
  domain = "localhost:3000",
  walletAddress,
  nonce,
  issuedAt = new Date().toISOString(),
  expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(),
}: BuildChallengeMessageOptions): string {
  return `${domain} wants you to sign in with your Stellar account:\n${walletAddress}\n\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpires At: ${expiresAt}`;
}

export function signChallengeMessage(kp: Keypair, message: string): string {
  return kp.sign(sep53Digest(message)).toString("hex");
}
