/**
 * creator.routes.ts
 *
 * GET  /api/v1/creators/:slug          — public profile
 * GET  /api/v1/creators/check/:slug    — slug availability check
 * POST /api/v1/creators/claim          — claim a slug (auth required)
 * PATCH /api/v1/creators/me            — update profile (auth required)
 * PATCH /api/v1/creators/me/splits     — update on-chain splits record (auth required)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  getCreatorBySlug,
  claimSlug,
  updateProfile,
  updateCreatorSplits,
  isSlugAvailable,
} from "./creator.service.js";

const ClaimBody = z.object({
  slug:        z.string().min(3).max(32),
  jarId:       z.string().min(1),
  displayName: z.string().max(80).optional(),
  bio:         z.string().max(300).optional(),
  splits:      z.array(z.object({ to: z.string(), bps: z.number().int() })).optional(),
});

const UpdateProfileBody = z.object({
  displayName: z.string().max(80).optional(),
  bio:         z.string().max(300).optional(),
  avatarUrl:   z.string().url().optional(),
});

const UpdateSplitsBody = z.object({
  splits: z.array(z.object({ to: z.string(), bps: z.number().int() })).min(1),
});

export const creatorRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /:slug — public ────────────────────────────────────────────────────
  app.get("/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const creator = await getCreatorBySlug(slug);
    return reply.send({ creator });
  });

  // ── GET /check/:slug — availability ───────────────────────────────────────
  app.get("/check/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const available = await isSlugAvailable(slug);
    return reply.send({ slug, available });
  });

  // ── POST /claim — auth required ────────────────────────────────────────────
  app.post(
    "/claim",
    { onRequest: [(app as any).authenticate] },
    async (request, reply) => {
      const body = ClaimBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const user = (request as any).user as { sub: string };
      const creator = await claimSlug({ creatorId: user.sub, ...body.data });
      return reply.status(201).send({ creator });
    },
  );

  // ── PATCH /me — auth required ──────────────────────────────────────────────
  app.patch(
    "/me",
    { onRequest: [(app as any).authenticate] },
    async (request, reply) => {
      const body = UpdateProfileBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const user = (request as any).user as { sub: string };
      const creator = await updateProfile({ creatorId: user.sub, ...body.data });
      return reply.send({ creator });
    },
  );

  // ── PATCH /me/splits — auth required ──────────────────────────────────────
  app.patch(
    "/me/splits",
    { onRequest: [(app as any).authenticate] },
    async (request, reply) => {
      const body = UpdateSplitsBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const user = (request as any).user as { sub: string };
      const creator = await updateCreatorSplits(user.sub, body.data.splits);
      return reply.send({ creator });
    },
  );
};
