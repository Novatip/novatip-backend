/**
 * webhooks.routes.ts
 *
 * GET    /api/v1/webhooks        — list creator's webhooks (auth)
 * POST   /api/v1/webhooks        — register a new webhook (auth)
 * DELETE /api/v1/webhooks/:id    — remove a webhook (auth)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
} from "./webhooks.service.js";
import { randomBytes } from "crypto";

const CreateBody = z.object({
  url: z.string().url(),
  /** Optional custom secret; auto-generated if omitted */
  secret: z.string().min(16).optional(),
});

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  // ── GET / ──────────────────────────────────────────────────────────────────
  app.get("/", async (request, reply) => {
    const { user } = request;
    const query = z
      .object({
        limit: z
          .string()
          .regex(/^[0-9]+$/)
          .transform(Number)
          .optional(),
        offset: z
          .string()
          .regex(/^[0-9]+$/)
          .transform(Number)
          .optional(),
      })
      .safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }
    const limit = Math.min(query.data.limit ?? 50, 100);
    const offset = query.data.offset ?? 0;
    const webhooks = await listWebhooks(user.sub, limit, offset);
    return reply.send({ webhooks });
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  app.post("/", async (request, reply) => {
    const body = CreateBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const { user } = request;
    const secret = body.data.secret ?? randomBytes(24).toString("hex");
    const webhook = await createWebhook(user.sub, body.data.url, secret);

    // Return the secret once on creation — it won't be shown again
    return reply.status(201).send({ webhook: { ...webhook, secret } });
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  app.delete("/:id", async (request, reply) => {
    const { user } = request;
    const { id } = request.params as { id: string };
    const deleted = await deleteWebhook(user.sub, id);
    if (!deleted) {
      return reply.status(404).send({ error: "Webhook not found" });
    }
    return reply.status(204).send();
  });
};
