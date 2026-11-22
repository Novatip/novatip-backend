import { createHash } from "crypto";
import type { Keypair } from "@stellar/stellar-sdk";

export const SEP53_PREFIX = "Stellar Signed Message:\n";

export function sep53Digest(message: string): Buffer {
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from(SEP53_PREFIX, "utf8"),
        Buffer.from(message, "utf8"),
      ]),
    )
    .digest();
}

export function signSep53Message(kp: Keypair, message: string): string {
  return kp.sign(sep53Digest(message)).toString("hex");
}

export interface BuildChallengeMessageOptions {
  walletAddress: string;
  nonce: string;
  domain?: string;
  issuedAt?: string;
  expiresAt?: string;
}

export function buildChallengeMessage(
  options: BuildChallengeMessageOptions,
): string {
  const domain = options.domain ?? "localhost:3000";
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const expiresAt =
    options.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString();

  return `${domain} wants you to sign in with your Stellar account:\n${options.walletAddress}\n\nNonce: ${options.nonce}\nIssued At: ${issuedAt}\nExpires At: ${expiresAt}`;
}
