/**
 * __tests__/auth/verify-challenge.test.ts
 *
 * Tests for verifyChallenge:
 * - Single query for existing creators (#88)
 * - Retries and bounded attempts on temporary slug collision (#89)
 */

import { jest } from "@jest/globals";
import { Prisma } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import { jarIdForSlug } from "../../modules/creator/jar-id.js";
import { buildChallengeMessage, signSep53Message } from "./auth-test.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

interface FakeCreatorRow {
  id: string;
  walletAddress: string;
  slug: string;
  jarId: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  email: string | null;
  splits: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const findUniqueMock =
  jest.fn<
    (args: {
      where: { walletAddress: string };
    }) => Promise<FakeCreatorRow | null>
  >();
const createMock =
  jest.fn<
    (args: {
      data: { walletAddress: string; slug: string; jarId: string };
    }) => Promise<FakeCreatorRow>
  >();
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

const { verifyChallenge, MAX_CREATOR_CREATE_ATTEMPTS } =
  await import("../../modules/auth/auth.service.js");

function makeFakeCreator(
  overrides: Partial<FakeCreatorRow> = {},
): FakeCreatorRow {
  return {
    id: "creator_123",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    slug: "user_abcd1234",
    jarId: "@user_abcd1234",
    displayName: null,
    bio: null,
    avatarUrl: null,
    email: null,
    splits: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function p2002Error(
  target: string[] = ["slug"],
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.15.0",
    meta: { target },
  });
}

describe("verifyChallenge (#88 single query and #89 slug collision handling)", () => {
  const kp = Keypair.random();
  const wallet = kp.publicKey();
  const nonce = "0123456789abcdef".repeat(4);
  let signedMessage: string;
  let sig: string;
  const signJwtMock = jest.fn(
    (_payload: { sub: string; wallet: string; slug: string }) =>
      "signed-jwt-token",
  );

  beforeEach(() => {
    jest.clearAllMocks();
    consumeAuthNonceMock.mockResolvedValue(nonce);
    signedMessage = buildChallengeMessage({ walletAddress: wallet, nonce });
    sig = signSep53Message(kp, signedMessage);
  });

  it("resolves an existing creator in a single query and returns isNewUser: false (#88)", async () => {
    const existingCreator = makeFakeCreator({ walletAddress: wallet });
    findUniqueMock.mockResolvedValue(existingCreator);

    const result = await verifyChallenge(wallet, signedMessage, sig, signJwtMock);

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: false });
    expect(consumeAuthNonceMock).toHaveBeenCalledTimes(1);
    expect(consumeAuthNonceMock).toHaveBeenCalledWith(wallet);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { walletAddress: wallet },
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(signJwtMock).toHaveBeenCalledWith({
      sub: existingCreator.id,
      wallet: wallet,
      slug: existingCreator.slug,
    });
  });

  it("creates a new creator when not found and returns isNewUser: true", async () => {
    findUniqueMock.mockResolvedValue(null);
    const newCreator = makeFakeCreator({
      walletAddress: wallet,
      slug: "user_11223344",
    });
    createMock.mockResolvedValue(newCreator);

    const result = await verifyChallenge(wallet, signedMessage, sig, signJwtMock);

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: true });
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletAddress: wallet,
        slug: expect.stringMatching(/^user_[0-9a-f]{8}$/),
        jarId: expect.stringMatching(/^@user_[0-9a-f]{8}$/),
      }),
    });
    const { data } = createMock.mock.calls[0]![0];
    expect(data.jarId).toBe(jarIdForSlug(data.slug));
    expect(signJwtMock).toHaveBeenCalledWith({
      sub: newCreator.id,
      wallet: wallet,
      slug: newCreator.slug,
    });
  });

  it("retries on slug/jarId collision (P2002) and succeeds on subsequent attempt (#89)", async () => {
    findUniqueMock.mockResolvedValue(null);
    const newCreator = makeFakeCreator({
      walletAddress: wallet,
      slug: "user_recovered",
    });

    // Fail first attempt with P2002 on slug, succeed second attempt
    createMock
      .mockRejectedValueOnce(p2002Error(["slug"]))
      .mockResolvedValueOnce(newCreator);

    const result = await verifyChallenge(wallet, signedMessage, sig, signJwtMock);

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: true });
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(signJwtMock).toHaveBeenCalledWith({
      sub: newCreator.id,
      wallet: wallet,
      slug: newCreator.slug,
    });
  });

  it("bounds the number of collision retry attempts and fails if all collide (#89)", async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockRejectedValue(p2002Error(["slug"]));

    await expect(
      verifyChallenge(wallet, signedMessage, sig, signJwtMock),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

    expect(createMock).toHaveBeenCalledTimes(MAX_CREATOR_CREATE_ATTEMPTS);
    expect(signJwtMock).not.toHaveBeenCalled();
  });

  it("handles concurrent first sign-in race gracefully without 500 and keeps isNewUser: true (#87)", async () => {
    // Initial lookup sees no creator (new user)
    findUniqueMock.mockResolvedValueOnce(null);

    const winningCreator = makeFakeCreator({
      walletAddress: wallet,
      slug: "user_winner",
    });

    // Create fails with P2002 on walletAddress because a concurrent request just inserted it
    createMock.mockRejectedValueOnce(p2002Error(["walletAddress"]));

    // Recovery lookup finds the winner row
    findUniqueMock.mockResolvedValueOnce(winningCreator);

    const result = await verifyChallenge(wallet, signedMessage, sig, signJwtMock);

    expect(result).toEqual({ jwt: "signed-jwt-token", isNewUser: true });
    expect(findUniqueMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(signJwtMock).toHaveBeenCalledWith({
      sub: winningCreator.id,
      wallet: wallet,
      slug: winningCreator.slug,
    });
  });
});
