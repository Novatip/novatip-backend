/**
 * __tests__/auth/verify-expiry.test.ts
 *
 * Tests for fail-closed challenge expiry validation in verifyChallenge (#250).
 */

import { jest } from "@jest/globals";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildChallengeMessage,
  signChallengeMessage,
} from "../helpers/auth-challenge.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const findUniqueMock = jest.fn<() => Promise<unknown>>();
const consumeAuthNonceMock =
  jest.fn<(walletAddress: string) => Promise<string | null>>();

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

const { verifyChallenge } =
  await import("../../modules/auth/auth.service.js");

describe("verifyChallenge expiry validation (#250)", () => {
  const kp = Keypair.random();
  const wallet = kp.publicKey();
  const nonce = "0123456789abcdef".repeat(4);
  const fixedNow = new Date("2026-06-01T12:00:00.000Z");
  const signJwtMock = jest.fn(() => "signed-jwt-token");

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);
    jest.clearAllMocks();
    consumeAuthNonceMock.mockResolvedValue(nonce);
    findUniqueMock.mockResolvedValue({
      id: "creator_1",
      walletAddress: wallet,
      slug: "alice",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("rejects with 401 when Expires At is not a valid date", async () => {
    const message = buildChallengeMessage({
      walletAddress: wallet,
      nonce,
      expiresAt: "not-a-date",
    });
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Challenge message has an invalid expiry.",
    });
    expect(consumeAuthNonceMock).toHaveBeenCalledWith(wallet);
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when Expires At line is missing", async () => {
    const issuedAt = new Date(fixedNow.getTime()).toISOString();
    const message = `localhost:3000 wants you to sign in with your Stellar account:\n${wallet}\n\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Challenge message has an invalid expiry.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when two Expires At lines are present", async () => {
    const futureIso = new Date(fixedNow.getTime() + 60_000).toISOString();
    const base = buildChallengeMessage({
      walletAddress: wallet,
      nonce,
      expiresAt: futureIso,
    });
    const message = `${base}\nExpires At: ${futureIso}`;
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Challenge message has an invalid expiry.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when Expires At value is empty", async () => {
    const message = buildChallengeMessage({
      walletAddress: wallet,
      nonce,
      expiresAt: "",
    });
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Challenge message has an invalid expiry.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 and existing message when Expires At is a valid past date", async () => {
    const pastIso = new Date(fixedNow.getTime() - 1000).toISOString();
    const message = buildChallengeMessage({
      walletAddress: wallet,
      nonce,
      expiresAt: pastIso,
    });
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Challenge message has expired.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("succeeds when Expires At is a valid future date", async () => {
    const futureIso = new Date(fixedNow.getTime() + 5 * 60_000).toISOString();
    const message = buildChallengeMessage({
      walletAddress: wallet,
      nonce,
      expiresAt: futureIso,
    });
    const sig = signChallengeMessage(kp, message);

    const result = await verifyChallenge(wallet, message, sig, signJwtMock);

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: false });
    expect(signJwtMock).toHaveBeenCalledTimes(1);
  });
});
