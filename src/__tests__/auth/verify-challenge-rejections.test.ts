/**
 * __tests__/auth/verify-challenge-rejections.test.ts
 *
 * Tests for verifyChallenge rejection branches and check ordering (#247):
 * - Malformed / non-G wallet address is rejected with 400 before touching Redis or DB
 * - Correctly signed message without "Nonce: <nonce>" is rejected with 401
 * - Nonce check runs before the Expires At check
 * - Correctly signed message with a past Expires At timestamp is rejected with 401
 * - Documents current fail-open behavior when Expires At is omitted
 */

import { jest } from "@jest/globals";
import { Keypair } from "@stellar/stellar-sdk";
import { buildChallengeMessage, signSep53Message } from "./auth-test.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const findUniqueMock = jest.fn(async () => ({
  id: "creator_123",
  walletAddress: "",
  slug: "user_abcd1234",
  jarId: "@user_abcd1234",
}));
const createMock = jest.fn();
const consumeAuthNonceMock =
  jest.fn<(walletAddress: string) => Promise<string | null>>();

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    creator: {
      findUnique: findUniqueMock,
      create: createMock,
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

describe("verifyChallenge rejection branches (#247)", () => {
  const kp = Keypair.random();
  const wallet = kp.publicKey();
  const nonce = "0123456789abcdef".repeat(4);
  const signJwtMock = jest.fn(() => "signed-jwt-token");
  const fixedNow = new Date("2026-06-01T12:00:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);
    jest.clearAllMocks();
    consumeAuthNonceMock.mockResolvedValue(nonce);
    findUniqueMock.mockResolvedValue({
      id: "creator_123",
      walletAddress: wallet,
      slug: "user_abcd1234",
      jarId: "@user_abcd1234",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("rejects a malformed wallet address with 400 before touching Redis or the database", async () => {
    const message = buildChallengeMessage({ walletAddress: wallet, nonce });
    const sig = signSep53Message(kp, message);

    await expect(
      verifyChallenge("not-a-stellar-address", message, sig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Invalid Stellar account address.",
      statusCode: 400,
    });

    expect(consumeAuthNonceMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects a non-G Stellar address (e.g. contract C... address) with 400 before touching Redis or the database", async () => {
    const contractAddress = `C${"A".repeat(55)}`;
    const message = buildChallengeMessage({
      walletAddress: contractAddress,
      nonce,
    });
    const sig = signSep53Message(kp, message);

    await expect(
      verifyChallenge(contractAddress, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Invalid Stellar account address.",
      statusCode: 400,
    });

    expect(consumeAuthNonceMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed message without a Nonce line with 401", async () => {
    const messageWithoutNonce = `localhost:3000 wants you to sign in with your Stellar account:\n${wallet}\n\nIssued At: ${fixedNow.toISOString()}\nExpires At: ${new Date(fixedNow.getTime() + 60_000).toISOString()}`;
    const sig = signSep53Message(kp, messageWithoutNonce);

    await expect(
      verifyChallenge(wallet, messageWithoutNonce, sig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Message does not contain expected nonce.",
      statusCode: 401,
    });

    expect(consumeAuthNonceMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("checks the expected nonce before checking Expires At", async () => {
    const expiredWithoutNonce = `localhost:3000 wants you to sign in with your Stellar account:\n${wallet}\n\nIssued At: ${new Date(fixedNow.getTime() - 120_000).toISOString()}\nExpires At: ${new Date(fixedNow.getTime() - 60_000).toISOString()}`;
    const sig = signSep53Message(kp, expiredWithoutNonce);

    await expect(
      verifyChallenge(wallet, expiredWithoutNonce, sig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Message does not contain expected nonce.",
      statusCode: 401,
    });

    expect(consumeAuthNonceMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed message whose Expires At timestamp is in the past with 401", async () => {
    const expiredMessage = buildChallengeMessage({
      walletAddress: wallet,
      nonce,
      issuedAt: new Date(fixedNow.getTime() - 10 * 60_000).toISOString(),
      expiresAt: new Date(fixedNow.getTime() - 1_000).toISOString(),
    });
    const sig = signSep53Message(kp, expiredMessage);

    await expect(
      verifyChallenge(wallet, expiredMessage, sig, signJwtMock),
    ).rejects.toMatchObject({
      message: "Challenge message has expired.",
      statusCode: 401,
    });

    expect(consumeAuthNonceMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("currently accepts a correctly signed message with no Expires At line (current fail-open behavior)", async () => {
    // Current behavior in auth.service.ts: `if (expiresMatch)` only checks expiry
    // when an "Expires At: ..." line is present, so omitting it skips expiry
    // validation (fail-open). Keep asserting current behavior until fixed.
    const messageWithoutExpiresAt = `localhost:3000 wants you to sign in with your Stellar account:\n${wallet}\n\nNonce: ${nonce}\nIssued At: ${fixedNow.toISOString()}`;
    const sig = signSep53Message(kp, messageWithoutExpiresAt);

    const result = await verifyChallenge(
      wallet,
      messageWithoutExpiresAt,
      sig,
      signJwtMock,
    );

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: false });
    expect(consumeAuthNonceMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(signJwtMock).toHaveBeenCalledTimes(1);
  });
});
