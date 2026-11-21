/**
 * creator.routes.ts
 *
 * GET  /api/v1/creators/:slug          — public profile
 * GET  /api/v1/creators/check/:slug    — slug availability check
 * POST /api/v1/creators/claim          — claim a slug (auth required)
 * PATCH /api/v1/creators/me            — update profile (auth required)
 * PATCH /api/v1/creators/me/splits     — update on-chain splits record (auth required)
 * PATCH /api/v1/creators/me/slug       — rename slug (auth required)
 * PATCH /api/v1/creators/tips/:tipId/message — hide or unhide a tip message (auth required)
 * DELETE /api/v1/creators/me           — delete the authenticated creator profile (auth required)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  getCreatorBySlug,
  claimSlug,
  renameSlug,
  updateProfile,
  updateCreatorSplits,
  isSlugAvailable,
  deleteCreator,
  type PublicCreator,
} from "./creator.service.js";
import { setTipMessageHidden } from "./messages.service.js";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { sendEmailVerificationEmail } from "../notifications/email.service.js";
import {
  creatorEmail,
  nullableHttpsUrl,
  nullableText,
  validateSlugParam,
} from "../../utils/validation.js";
import { CreatorSplitsSchema } from "./creator-splits.schema.js";

const RenameSlugBody = z.object({
  slug: z.string().min(3).max(32),
});

const ClaimBody = z.object({
  slug: z.string().min(3).max(32),
  // Optional: the stored jarId is derived from the slug. A supplied value is
  // still checked against it, so an out-of-sync client gets a 400 rather than
  // a creator whose page and on-chain jar disagree.
  jarId: z.string().min(1).optional(),
  displayName: z.string().max(80).optional(),
  bio: z.string().max(300).optional(),
  splits: CreatorSplitsSchema.optional(),
});

const UpdateProfileBody = z.object({
  // Nullable so each field can be cleared; omitting a key leaves it
  // unchanged. displayName, bio and avatarUrl also treat an empty or
  // whitespace-only string as a clear — see nullableText/nullableHttpsUrl.
  displayName: nullableText(80, "Display name").optional(),
  bio: nullableText(300, "Bio").optional(),
  avatarUrl: nullableHttpsUrl("Avatar URL").optional(),
  email: creatorEmail.nullable().optional(),
});

const UpdateSplitsBody = z.object({
  splits: CreatorSplitsSchema.refine((splits) => splits.length > 0, {
    message: "At least one split is required.",
  }),
});

const MessageVisibilityBody = z.object({
  hidden: z.boolean(),
});

const EmailVerificationQuery = z.object({
  token: z.string().min(1),
});

export const creatorRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /:slug — public ────────────────────────────────────────────────────
  app.get("/:slug", async (request, reply) => {
    const slug = validateSlugParam(request.params, reply);
    if (slug === null) return;

    const creator: PublicCreator = await getCreatorBySlug(slug);
    return reply.send({ creator });
  });

  // ── GET /check/:slug — availability ───────────────────────────────────────
  app.get("/check/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    // The endpoint stays public, but identity matters here: a released slug
    // is held for its previous owner, and only a token proves the caller is
    // that owner. No token, or an invalid one, simply reads as anonymous —
    // claim and rename still enforce the hold server-side either way.
    let viewerId: string | undefined;
    try {
      await request.jwtVerify();
      viewerId = request.user.sub;
    } catch {
      // Unauthenticated callers get the hold applied to everyone.
    }

    const available = await isSlugAvailable(slug, viewerId);
    return reply.send({ slug, available });
  });

  // ── POST /claim — auth required ────────────────────────────────────────────
  app.post(
    "/claim",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const body = ClaimBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { user } = request;
      const creator = await claimSlug({ creatorId: user.sub, ...body.data });
      return reply.status(201).send({ creator });
    },
  );

  // ── PATCH /me — auth required ──────────────────────────────────────────────
  app.patch(
    "/me",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const body = UpdateProfileBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { user } = request;
      const creator = await updateProfile({
        creatorId: user.sub,
        ...body.data,
      });

      if (body.data.email && !creator.emailVerifiedAt) {
        const token = app.jwt.sign(
          {
            sub: creator.id,
            email: body.data.email,
            purpose: "creator-email-verification",
          },
          { expiresIn: "24h" },
        );
        const confirmationUrl = new URL(
          "/api/v1/creators/email/verify",
          config.apiBaseUrl,
        );
        confirmationUrl.searchParams.set("token", token);
        await sendEmailVerificationEmail(
          body.data.email,
          confirmationUrl.toString(),
        );
      }

      return reply.send({ creator });
    },
  );

  // ── GET /email/verify — confirm a notification email using a signed link ──
  app.get("/email/verify", async (request, reply) => {
    const query = EmailVerificationQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    let claims: ReturnType<typeof app.jwt.verify>;
    try {
      claims = app.jwt.verify(query.data.token);
    } catch {
      return reply.status(400).send({
        error: {
          code: "INVALID_EMAIL_VERIFICATION_TOKEN",
          message: "The email verification link is invalid or has expired.",
        },
      });
    }
    if (
      claims.purpose !== "creator-email-verification" ||
      typeof claims.sub !== "string" ||
      typeof claims.email !== "string"
    ) {
      return reply.status(400).send({
        error: {
          code: "INVALID_EMAIL_VERIFICATION_TOKEN",
          message: "The email verification link is invalid or has expired.",
        },
      });
    }

    const result = await db.creator.updateMany({
      where: {
        id: claims.sub,
        email: claims.email,
        emailVerifiedAt: null,
      },
      data: { emailVerifiedAt: new Date() },
    });
    if (result.count === 0) {
      return reply.status(400).send({
        error: {
          code: "INVALID_EMAIL_VERIFICATION_TOKEN",
          message: "The email address changed or has already been verified.",
        },
      });
    }

    return reply.send({ verified: true });
  });

  // ── PATCH /me/splits — auth required ──────────────────────────────────────
  app.patch(
    "/me/splits",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const body = UpdateSplitsBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { user } = request;
      const creator = await updateCreatorSplits(user.sub, body.data.splits);
      return reply.send({ creator });
    },
  );

  // ── PATCH /me/slug — auth required ─────────────────────────────────────────
  app.patch(
    "/me/slug",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const body = RenameSlugBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { user } = request;
      const creator = await renameSlug({
        creatorId: user.sub,
        slug: body.data.slug,
      });
      return reply.send({ creator });
    },
  );

  // ── DELETE /me — auth required ────────────────────────────────────────────
  // Removes the profile, notifications, webhooks, and delivery history. Tips
  // remain as financial history and are detached from the deleted profile.
  app.delete(
    "/me",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      await deleteCreator(request.user.sub);
      return reply.status(204).send();
    },
  );

  // ── PATCH /tips/:tipId/message — auth required ────────────────────────────
  app.patch(
    "/tips/:tipId/message",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const body = MessageVisibilityBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { tipId } = request.params as { tipId: string };
      const { user } = request;
      const tip = await setTipMessageHidden(user.sub, tipId, body.data.hidden);

      if (!tip) {
        // Missing and not-yours are the same answer — see setTipMessageHidden.
        return reply.status(404).send({
          error: {
            code: "TIP_NOT_FOUND",
            message: "Tip not found",
          },
        });
      }

      return reply.send({ tip });
    },
  );
};
