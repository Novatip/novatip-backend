/**
 * __tests__/auth/verify-domain.test.ts
 *
 * Tests for domain binding verification in verifyChallenge (#249).
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
process.env["APP_BASE_URL"] = "https://app.novatip.xyz:8443";

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

const { config } = await import("../../config.js");
const { verifyChallenge, getExpectedAuthDomain } =
  await import("../../modules/auth/auth.service.js");

describe("verifyChallenge domain binding (#249)", () => {
  const kp = Keypair.random();
  const wallet = kp.publicKey();
  const nonce = "0123456789abcdef".repeat(4);
  const signJwtMock = jest.fn(() => "signed-jwt-token");
  const originalAppBaseUrl = config.appBaseUrl;

  beforeEach(() => {
    jest.clearAllMocks();
    (config as { appBaseUrl: string }).appBaseUrl = originalAppBaseUrl;
    consumeAuthNonceMock.mockResolvedValue(nonce);
    findUniqueMock.mockResolvedValue({
      id: "creator_1",
      walletAddress: wallet,
      slug: "alice",
    });
  });

  afterAll(() => {
    (config as { appBaseUrl: string }).appBaseUrl = originalAppBaseUrl;
  });

  it("rejects with 401 when the message names a different domain", async () => {
    const message = buildChallengeMessage({
      domain: "evil.example.com",
      walletAddress: wallet,
      nonce,
    });
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Message domain does not match this server.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the domain line is missing", async () => {
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const message = `${wallet}\n\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpires At: ${expiresAt}`;
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Message domain does not match this server.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the right domain appears only on a later line", async () => {
    const expectedDomain = getExpectedAuthDomain();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const message = `other.example.com wants you to sign in with your Stellar account:\n${expectedDomain} wants you to sign in with your Stellar account:\n${wallet}\n\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpires At: ${expiresAt}`;
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Message domain does not match this server.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 on port mismatch", async () => {
    const message = buildChallengeMessage({
      domain: "app.novatip.xyz:3000",
      walletAddress: wallet,
      nonce,
    });
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Message domain does not match this server.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when domain contains userinfo or slashes", async () => {
    for (const badDomain of [
      "user@app.novatip.xyz:8443",
      "https://app.novatip.xyz:8443",
      "app.novatip.xyz:8443/extra",
    ]) {
      const message = buildChallengeMessage({
        domain: badDomain,
        walletAddress: wallet,
        nonce,
      });
      const sig = signChallengeMessage(kp, message);

      await expect(
        verifyChallenge(wallet, message, sig, signJwtMock),
      ).rejects.toMatchObject({
        statusCode: 401,
        message: "Message domain does not match this server.",
      });
    }
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("accepts different case in the host and returns the session", async () => {
    const message = buildChallengeMessage({
      domain: "APP.NOVATIP.XYZ:8443",
      walletAddress: wallet,
      nonce,
    });
    const sig = signChallengeMessage(kp, message);

    const result = await verifyChallenge(wallet, message, sig, signJwtMock);

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: false });
    expect(signJwtMock).toHaveBeenCalledTimes(1);
  });

  it("succeeds when the domain matches config.appBaseUrl", async () => {
    const message = buildChallengeMessage({
      domain: getExpectedAuthDomain(),
      walletAddress: wallet,
      nonce,
    });
    const sig = signChallengeMessage(kp, message);

    const result = await verifyChallenge(wallet, message, sig, signJwtMock);

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: false });
    expect(signJwtMock).toHaveBeenCalledTimes(1);
  });

  it("fails safe when config.appBaseUrl is invalid at runtime", async () => {
    (config as { appBaseUrl: string }).appBaseUrl = "not-a-valid-url";
    const message = buildChallengeMessage({
      domain: "app.novatip.xyz:8443",
      walletAddress: wallet,
      nonce,
    });
    const sig = signChallengeMessage(kp, message);

    await expect(
      verifyChallenge(wallet, message, sig, signJwtMock),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "Server authentication domain is not configured.",
    });
    expect(signJwtMock).not.toHaveBeenCalled();
  });
});
