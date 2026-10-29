/**
 * auth.routes.ts
 *
 * POST /api/v1/auth/challenge  — issue a one-time sign-in nonce
 * POST /api/v1/auth/verify     — verify signed nonce, return JWT
 * GET  /api/v1/auth/me         — return current user from JWT
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { registerDedicatedRateLimit } from "../../utils/rate-limit.js";
import { generateChallenge, verifyChallenge } from "./auth.service.js";

/**
 * The challenge and verification endpoints have dedicated per-IP limits:
 * challenge bounds nonce creation and verification bounds signature checks
 * plus database work, in addition to the shared global request budget.
 */
const AUTH_CHALLENGE_RATE_LIMIT = config.rateLimits.authChallenge;
const AUTH_VERIFY_RATE_LIMIT = config.rateLimits.authVerify;

const ChallengeBody = z.object({
  walletAddress: z.string().min(56).max(56),
});

const VerifyBody = z.object({
  walletAddress: z.string().min(56).max(56),
  message: z.string(),
  signatureHex: z.string().length(128),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /challenge ────────────────────────────────────────────────────────
  await app.register(async (challengeApp) => {
    await registerDedicatedRateLimit(challengeApp, {
      max: AUTH_CHALLENGE_RATE_LIMIT,
      nameSpace: "novatip-auth-challenge-rate-limit-",
      code: "AUTH_RATE_LIMITED",
      message: "Too many auth requests. Try again in a minute.",
    });

    challengeApp.post("/challenge", async (request, reply) => {
      const body = ChallengeBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const domain = new URL(config.appBaseUrl).host;
      const challenge = await generateChallenge(
        body.data.walletAddress,
        domain,
      );
      return reply.send(challenge);
    });
  });

  // ── POST /verify ───────────────────────────────────────────────────────────
  await app.register(async (verifyApp) => {
    await registerDedicatedRateLimit(verifyApp, {
      max: AUTH_VERIFY_RATE_LIMIT,
      nameSpace: "novatip-auth-verify-rate-limit-",
      code: "AUTH_RATE_LIMITED",
      message: "Too many auth requests. Try again in a minute.",
    });

    verifyApp.post("/verify", async (request, reply) => {
      const body = VerifyBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { jwt, isNewUser } = await verifyChallenge(
        body.data.walletAddress,
        body.data.message,
        body.data.signatureHex,
        (payload) => app.jwt.sign(payload),
      );

      return reply.send({ jwt, isNewUser });
    });
  });

  // ── GET /me ────────────────────────────────────────────────────────────────
  app.get("/me", { onRequest: [app.authenticate] }, async (request, reply) => {
    const creator = await db.creator.findUnique({
      where: { id: request.user.sub },
      select: { slug: true, emailVerifiedAt: true },
    });

    if (!creator) {
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Creator not found.",
        },
      });
    }

    return reply.send({
      user: {
        ...request.user,
        slug: creator.slug,
        emailVerifiedAt: creator.emailVerifiedAt,
      },
    });
  });
};
