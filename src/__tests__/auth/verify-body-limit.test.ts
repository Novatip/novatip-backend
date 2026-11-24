/**
 * __tests__/auth/verify-body-limit.test.ts
 *
 * Tests that POST /verify enforces an explicit maximum length on
 * VerifyBody.message via Zod validation (returning 400 before verifyChallenge).
 */

import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";
import { createRateLimitRedisMock } from "../helpers/rate-limit-redis.helper.js";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["AUTH_VERIFY_RATE_LIMIT"] = "100";

const rateLimitRedis = createRateLimitRedisMock();
const verifyChallengeMock = jest.fn(
  async (
    _walletAddress: string,
    _message: string,
    _signatureHex: string,
    signJwt: (payload: { sub: string; wallet: string; slug: string }) => string,
  ) => ({
    jwt: signJwt({ sub: "creator_1", wallet: "Gwallet", slug: "alice" }),
    isNewUser: false,
  }),
);

jest.unstable_mockModule("../../modules/auth/auth.service.js", () => ({
  generateChallenge: jest.fn(),
  verifyChallenge: verifyChallengeMock,
}));
jest.unstable_mockModule("../../redis.js", () => ({
  redis: rateLimitRedis.redis,
}));

const { authRoutes, AUTH_VERIFY_MESSAGE_MAX_LENGTH } = await import(
  "../../modules/auth/auth.routes.js"
);

const VALID_WALLET = `G${"A".repeat(55)}`;
const VALID_SIGNATURE_HEX = "ab".repeat(64);

describe("POST /verify message length bound (#251)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(jwtPlugin, {
      secret: "test-secret-at-least-32-chars-long-123456",
    });
    app.decorate("authenticate", async () => undefined);
    await app.register(authRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimitRedis.clear();
  });

  it("rejects a message exceeding AUTH_VERIFY_MESSAGE_MAX_LENGTH with 400 before calling verifyChallenge", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/verify",
      payload: {
        walletAddress: VALID_WALLET,
        message: "x".repeat(AUTH_VERIFY_MESSAGE_MAX_LENGTH + 1),
        signatureHex: VALID_SIGNATURE_HEX,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        fieldErrors: {
          message: expect.arrayContaining([expect.any(String)]),
        },
      },
    });
    expect(verifyChallengeMock).not.toHaveBeenCalled();
  });

  it("rejects an empty message with 400 before calling verifyChallenge", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/verify",
      payload: {
        walletAddress: VALID_WALLET,
        message: "",
        signatureHex: VALID_SIGNATURE_HEX,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        fieldErrors: {
          message: expect.arrayContaining([expect.any(String)]),
        },
      },
    });
    expect(verifyChallengeMock).not.toHaveBeenCalled();
  });

  it("accepts a message at AUTH_VERIFY_MESSAGE_MAX_LENGTH and passes it to verifyChallenge", async () => {
    const maxMessage = "x".repeat(AUTH_VERIFY_MESSAGE_MAX_LENGTH);

    const response = await app.inject({
      method: "POST",
      url: "/verify",
      payload: {
        walletAddress: VALID_WALLET,
        message: maxMessage,
        signatureHex: VALID_SIGNATURE_HEX,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(verifyChallengeMock).toHaveBeenCalledWith(
      VALID_WALLET,
      maxMessage,
      VALID_SIGNATURE_HEX,
      expect.any(Function),
    );
  });
});
