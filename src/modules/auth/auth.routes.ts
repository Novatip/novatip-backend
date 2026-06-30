/**
 * auth.routes.ts
 *
 * POST /api/v1/auth/challenge  — issue a one-time sign-in nonce
 * POST /api/v1/auth/verify     — verify signed nonce, return JWT
 * GET  /api/v1/auth/me         — return current user from JWT
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { generateChallenge, verifyChallenge } from "./auth.service.js";

const ChallengeBody = z.object({
  walletAddress: z.string().min(56).max(56),
});

const VerifyBody = z.object({
  walletAddress: z.string().min(56).max(56),
  signatureHex:  z.string().length(128),   // 64-byte sig → 128 hex chars
  publicKeyHex:  z.string().length(64),    // 32-byte key → 64 hex chars
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /challenge ────────────────────────────────────────────────────────
  app.post("/challenge", async (request, reply) => {
    const body = ChallengeBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const nonce = await generateChallenge(body.data.walletAddress);
    return reply.send({ nonce });
  });

  // ── POST /verify ───────────────────────────────────────────────────────────
  app.post("/verify", async (request, reply) => {
    const body = VerifyBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const { jwt, isNewUser } = await verifyChallenge(
      body.data.walletAddress,
      body.data.signatureHex,
      body.data.publicKeyHex,
      (payload) => app.jwt.sign(payload),
    );

    return reply.send({ jwt, isNewUser });
  });

  // ── GET /me ────────────────────────────────────────────────────────────────
  app.get(
    "/me",
    { onRequest: [(app as any).authenticate] },
    async (request, reply) => {
      return reply.send({ user: (request as any).user });
    },
  );
};
