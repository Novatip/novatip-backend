/**
 * __tests__/auth/challenge-single-use.test.ts
 *
 * Verifies single-use nonce lifecycle during challenge verification (#90):
 * - Nonce is consumed immediately upon retrieval before signature verification.
 * - A failed signature verification attempt burns the nonce and explicitly tells
 *   the client that a new challenge is required.
 * - Retrying with the same nonce is rejected with "Challenge not found or expired".
 */

import { jest } from "@jest/globals";
import { Keypair } from "@stellar/stellar-sdk";
import { buildChallengeMessage } from "./auth-test.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const store = new Map<string, string>();

const mockRedis = {
  get: async (key: string): Promise<string | null> => store.get(key) ?? null,
  getdel: async (key: string): Promise<string | null> => {
    const value = store.get(key) ?? null;
    store.delete(key);
    return value;
  },
  set: async (key: string, value: string): Promise<"OK"> => {
    store.set(key, value);
    return "OK";
  },
  del: async (key: string): Promise<number> => (store.delete(key) ? 1 : 0),
  on: () => undefined,
  quit: async (): Promise<"OK"> => "OK",
};

jest.unstable_mockModule("ioredis", () => ({
  Redis: function Redis() {
    return mockRedis;
  },
  default: function Redis() {
    return mockRedis;
  },
}));

const mockDb = {
  creator: {
    findUnique: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    create: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
    findUniqueOrThrow: jest.fn().mockImplementation(() =>
      Promise.resolve({
        id: "creator_test",
        walletAddress: "G...",
        slug: "user_test",
        jarId: "@user_test",
      }),
    ),
  },
};

jest.unstable_mockModule("../../db.js", () => ({
  db: mockDb,
  disconnectDb: async (): Promise<void> => undefined,
}));

const { setAuthNonce } = await import("../../redis.js");
const { verifyChallenge } = await import("../../modules/auth/auth.service.js");

describe("verifyChallenge single-use nonce behavior", () => {
  const kp = Keypair.random();
  const walletAddress = kp.publicKey();
  const mockSignJwt = () => "mock.jwt.token";

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
  });

  it("consumes the nonce on a failed signature attempt and explains a new challenge is required", async () => {
    const nonce = "0123456789abcdef".repeat(4);
    await setAuthNonce(walletAddress, nonce);
    const signedMessage = buildChallengeMessage({ walletAddress, nonce });

    // Provide an invalid signature
    const badSignatureHex = "00".repeat(64);

    // First attempt: signature verification fails
    await expect(
      verifyChallenge(walletAddress, signedMessage, badSignatureHex, mockSignJwt),
    ).rejects.toMatchObject({
      message: "Signature verification failed. Request a new challenge.",
      statusCode: 401,
    });

    // The nonce was consumed during the first attempt, burning it
    expect(store.has(`nonce:${walletAddress}`)).toBe(false);
    expect(mockDb.creator.findUnique).not.toHaveBeenCalled();

    // Second attempt with the same nonce: rejected as missing/expired
    await expect(
      verifyChallenge(walletAddress, signedMessage, badSignatureHex, mockSignJwt),
    ).rejects.toMatchObject({
      message: "Challenge not found or expired. Request a new challenge.",
      statusCode: 401,
    });
  });
});
