/**
 * webhooks.routes.ts
 *
 * GET    /api/v1/webhooks        — list creator's webhooks (auth)
 * POST   /api/v1/webhooks        — register a new webhook (auth)
 * DELETE /api/v1/webhooks/:id    — remove a webhook (auth)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createWebhook, listWebhooks, deleteWebhook } from "./webhooks.service.js";
import { randomBytes } from "crypto";

const CreateBody = z.object({
  url: z.string().url(),
  /** Optional custom secret; auto-generated if omitted */
  secret: z.string().min(16).optional(),
});

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", (app as any).authenticate);

  // ── GET / ──────────────────────────────────────────────────────────────────
  app.get("/", async (request, reply) => {
    const user = (request as any).user as { sub: string };
    const webhooks = await listWebhooks(user.sub);
    return reply.send({ webhooks });
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  app.post("/", async (request, reply) => {
    const body = CreateBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const user   = (request as any).user as { sub: string };
    const secret = body.data.secret ?? randomBytes(24).toString("hex");
    const webhook = await createWebhook(user.sub, body.data.url, secret);

    // Return the secret once on creation — it won't be shown again
    return reply.status(201).send({ webhook: { ...webhook, secret } });
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  app.delete("/:id", async (request, reply) => {
    const user = (request as any).user as { sub: string };
    const { id } = request.params as { id: string };
    await deleteWebhook(user.sub, id);
    return reply.status(204).send();
  });
};
