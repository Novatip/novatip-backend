/**
 * sep53.test.ts
 *
 * The wallet sign-in signature format.
 *
 * Freighter's signMessage follows SEP-53: it signs
 * SHA256("Stellar Signed Message:\n" + message), not the raw bytes. The
 * verifier originally only checked the raw bytes, so every browser sign-in
 * was rejected and the dashboard could never load. These tests pin both
 * accepted payloads and, just as importantly, the rejections.
 */

import nacl from "tweetnacl";
import { createHash } from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const SEP53_PREFIX = "Stellar Signed Message:\n";

function sep53Digest(message: string): Buffer {
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from(SEP53_PREFIX, "utf8"),
        Buffer.from(message, "utf8"),
      ]),
    )
    .digest();
}

/** Mirrors verifyEd25519 in modules/auth/auth.service.ts. */
function verify(
  nonce: string,
  signatureHex: string,
  publicKey: Buffer,
): boolean {
  const signature = Buffer.from(signatureHex, "hex");
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = new Uint8Array(publicKey);
  const sig = new Uint8Array(signature);
  return [sep53Digest(nonce), Buffer.from(nonce, "utf8")].some((payload) =>
    nacl.sign.detached.verify(new Uint8Array(payload), sig, key),
  );
}

const NONCE = "0123456789abcdef".repeat(4);

describe("challenge signature verification", () => {
  const kp = Keypair.random();
  const pub = Buffer.from(StrKey.decodeEd25519PublicKey(kp.publicKey()));

  it("accepts a SEP-53 signature, which is what wallets produce", () => {
    const sig = kp.sign(sep53Digest(NONCE)).toString("hex");
    expect(verify(NONCE, sig, pub)).toBe(true);
  });

  it("accepts a raw-nonce signature, for scripts signing with a keypair", () => {
    const sig = kp.sign(Buffer.from(NONCE, "utf8")).toString("hex");
    expect(verify(NONCE, sig, pub)).toBe(true);
  });

  it("rejects a signature from a different key", () => {
    const sig = Keypair.random().sign(sep53Digest(NONCE)).toString("hex");
    expect(verify(NONCE, sig, pub)).toBe(false);
  });

  it("rejects a valid signature over a different nonce", () => {
    const sig = kp.sign(sep53Digest(NONCE)).toString("hex");
    expect(verify("a-different-nonce", sig, pub)).toBe(false);
  });

  it("rejects a malformed signature", () => {
    expect(verify(NONCE, "not-hex", pub)).toBe(false);
    expect(verify(NONCE, "ab".repeat(10), pub)).toBe(false);
  });
});
