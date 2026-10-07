/**
 * webhooks.routes.ts
 *
 * GET    /api/v1/webhooks        — list creator's webhooks (auth)
 * POST   /api/v1/webhooks        — register a new webhook (auth)
 *                                  409 WEBHOOK_LIMIT_REACHED once the creator
 *                                  holds MAX_WEBHOOKS_PER_CREATOR webhooks
 * PATCH  /api/v1/webhooks/:id    — enable or disable a webhook (auth)
 * DELETE /api/v1/webhooks/:id    — remove a webhook (auth)
 *
 * GET    /api/v1/webhooks/:id/deliveries — recent delivery attempts (auth)
 * POST   /api/v1/webhooks/:id/ping       — send a signed test payload (auth)
 * POST   /api/v1/webhooks/:id/secret     — rotate the signing secret (auth)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createWebhook,
  listWebhooks,
  listWebhookDeliveries,
  sendTestPing,
  setWebhookEnabled,
  rotateWebhookSecret,
  deleteWebhook,
  generateWebhookSecret,
  DEFAULT_DELIVERY_PAGE_SIZE,
  MAX_DELIVERY_PAGE_SIZE,
} from "./webhooks.service.js";

/**
 * A caller-supplied signing secret. Shared by registration and rotation so
 * the two cannot drift on what they accept. 16 characters is the floor for
 * something used as an HMAC key; omit the field and the server mints one with
 * 192 bits of entropy instead, which is the better choice.
 */
const webhookSecret = z.string().min(16);

const CreateBody = z.object({
  url: z.string().url(),
  /** Optional custom secret; auto-generated if omitted */
  secret: webhookSecret.optional(),
});

const RotateBody = z.object({
  /** Optional custom secret; a fresh one is generated if omitted */
  secret: webhookSecret.optional(),
});

/**
 * The toggle takes the target state rather than flipping whatever is stored.
 * A "pause this" button that sends the state it wants is idempotent — a retry
 * after a dropped response cannot silently re-enable the webhook.
 */
const EnabledBody = z.object({
  enabled: z.boolean(),
});

/**
 * Delivery-history paging. Exported so the bounds can be unit tested without
 * standing up the server — they are the endpoint's contract, not a detail.
 *
 * The bounds are stated in the schema rather than clamped afterwards, so
 * ?limit=500 is a 400 naming the ceiling instead of a silent 100 — a caller
 * paging through history needs to know its page was shortened. Query values
 * arrive as strings, hence the coercion.
 */
export const DeliveryQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_DELIVERY_PAGE_SIZE)
    .default(DEFAULT_DELIVERY_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
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
    const secret = body.data.secret ?? generateWebhookSecret();
    const webhook = await createWebhook(user.sub, body.data.url, secret);

    // Return the secret once on creation — it won't be shown again
    return reply.status(201).send({ webhook: { ...webhook, secret } });
  });

  // ── PATCH /:id ─────────────────────────────────────────────────────────────
  app.patch("/:id", async (request, reply) => {
    const body = EnabledBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const { user } = request;
    const { id } = request.params as { id: string };
    const webhook = await setWebhookEnabled(user.sub, id, body.data.enabled);

    // Missing and not-yours are the same answer — see setWebhookEnabled.
    if (!webhook) {
      return reply.status(404).send({ error: "Webhook not found" });
    }

    return reply.send({ webhook });
  });

  // ── GET /:id/deliveries ────────────────────────────────────────────────────
  app.get("/:id/deliveries", async (request, reply) => {
    const query = DeliveryQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    const { user } = request;
    const { id } = request.params as { id: string };
    const deliveries = await listWebhookDeliveries(
      user.sub,
      id,
      query.data.limit,
      query.data.offset,
    );

    // null means the caller owns no webhook with that id. A webhook that
    // simply has not fired yet returns an empty array, not a 404.
    if (deliveries === null) {
      return reply.status(404).send({ error: "Webhook not found" });
    }

    return reply.send({ deliveries });
  });

  // ── POST /:id/ping ─────────────────────────────────────────────────────────
  app.post(
    "/:id/ping",
    {
      // Tighter than the global 100/min. This is the one route where a caller
      // chooses a URL and has the server fetch it on demand, so it should not
      // be usable as a traffic amplifier against a third party — a creator
      // verifying a receiver needs a handful of attempts, not a hundred.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { user } = request;
      const { id } = request.params as { id: string };
      const delivery = await sendTestPing(user.sub, id);

      if (delivery === null) {
        return reply.status(404).send({ error: "Webhook not found" });
      }

      // 200 even when the receiver rejected the ping. The request to *this*
      // API succeeded; the receiver's answer is the payload, and failing the
      // whole call would make "your endpoint is broken" indistinguishable
      // from "the ping endpoint is broken".
      return reply.send({ delivery });
    },
  );

  // ── POST /:id/secret ───────────────────────────────────────────────────────
  app.post("/:id/secret", async (request, reply) => {
    // The body is optional on this route — rotating without choosing a secret
    // is the normal case, and a client sending no body at all should not get
    // a validation error for it.
    const body = RotateBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const { user } = request;
    const { id } = request.params as { id: string };
    const rotated = await rotateWebhookSecret(
      user.sub,
      id,
      body.data.secret ?? generateWebhookSecret(),
    );

    if (!rotated) {
      return reply.status(404).send({ error: "Webhook not found" });
    }

    // Returned once, as at registration — there is no route that reads a
    // secret back out, which is why rotation exists.
    return reply.send({ webhook: rotated });
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
