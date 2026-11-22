/**
 * __tests__/auth/sep53.test.ts
 *
 * Tests for SEP-53 wallet sign-in signature verification via the real
 * verifyChallenge / verifyEd25519 implementation in auth.service.ts.
 *
 * Freighter and SEP-53 wallets sign:
 *   SHA256("Stellar Signed Message:\n" + message)
 * rather than raw message bytes or a raw nonce. Signatures that do not use
 * the SEP-53 digest, use the wrong keypair, target a different message, or
 * are tampered/malformed must be rejected.
 */

import { jest } from "@jest/globals";
import { Keypair } from "@stellar/stellar-sdk";
import { buildChallengeMessage, signSep53Message } from "./auth-test.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const consumeAuthNonceMock =
  jest.fn<(walletAddress: string) => Promise<string | null>>();

const findUniqueMock = jest.fn(async () => ({
  id: "creator_sep53",
  walletAddress: "",
  slug: "user_sep53",
  jarId: "@user_sep53",
}));

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: findUniqueMock,
      create: jest.fn(),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  consumeAuthNonce: consumeAuthNonceMock,
  setAuthNonce: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { verifyChallenge } = await import("../../modules/auth/auth.service.js");

const NONCE = "0123456789abcdef".repeat(4);

describe("SEP-53 challenge signature verification", () => {
  const kp = Keypair.random();
  const wallet = kp.publicKey();
  const signJwtMock = jest.fn(() => "signed-jwt-token");

  let message: string;

  beforeEach(() => {
    jest.clearAllMocks();
    consumeAuthNonceMock.mockResolvedValue(NONCE);
    message = buildChallengeMessage({ walletAddress: wallet, nonce: NONCE });
    findUniqueMock.mockResolvedValue({
      id: "creator_sep53",
      walletAddress: wallet,
      slug: "user_sep53",
      jarId: "@user_sep53",
    });
  });

  it("accepts a valid SEP-53 signature over the challenge message", async () => {
    const sig = signSep53Message(kp, message);

    const result = await verifyChallenge(wallet, message, sig, signJwtMock);

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: false });
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(signJwtMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a raw-nonce signature without the SEP-53 prefix", async () => {
    const rawNonceSig = kp.sign(Buffer.from(NONCE, "utf8")).toString("hex");

    await expect(
      verifyChallenge(wallet, message, rawNonceSig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Signature verification failed. Request a new challenge.",
      statusCode: 401,
    });

    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("rejects a signature from a different keypair", async () => {
    const otherKp = Keypair.random();
    const sig = signSep53Message(otherKp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Signature verification failed. Request a new challenge.",
      statusCode: 401,
    });

    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("rejects a valid SEP-53 signature over a different message", async () => {
    const otherMessage = buildChallengeMessage({
      walletAddress: wallet,
      nonce: NONCE,
      domain: "evil.example.com",
    });
    const sig = signSep53Message(kp, otherMessage);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Signature verification failed. Request a new challenge.",
      statusCode: 401,
    });

    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("rejects a tampered signature", async () => {
    const sig = signSep53Message(kp, message);
    const flippedFirstByte = ((parseInt(sig.slice(0, 2), 16) ^ 0xff) & 0xff)
      .toString(16)
      .padStart(2, "0");
    const tamperedSig = flippedFirstByte + sig.slice(2);

    await expect(
      verifyChallenge(wallet, message, tamperedSig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Signature verification failed. Request a new challenge.",
      statusCode: 401,
    });

    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("rejects malformed signatures (non-hex and wrong length) without throwing an unhandled error", async () => {
    await expect(
      verifyChallenge(wallet, message, "not-hex", signJwtMock),
    ).rejects.toMatchObject({
      message: "Signature verification failed. Request a new challenge.",
      statusCode: 401,
    });

    await expect(
      verifyChallenge(wallet, message, "ab".repeat(10), signJwtMock),
    ).rejects.toMatchObject({
      message: "Signature verification failed. Request a new challenge.",
      statusCode: 401,
    });

    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
