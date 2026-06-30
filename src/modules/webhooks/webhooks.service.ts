/**
 * webhooks.service.ts
 *
 * Dispatches TipReceived events to creator-registered webhook URLs.
 *
 * Security: each delivery is signed with HMAC-SHA256 using the webhook's
 * shared secret. The receiving server can verify:
 *   X-Novatip-Signature: sha256=<hex>
 */

import { createHmac } from "crypto";
import { db } from "../../db.js";
import type { TipEvent } from "@novatip/sdk";
import { stroopsToUsdc } from "@novatip/sdk";

const TIMEOUT_MS    = 5_000;
const MAX_BODY_SIZE = 1_024; // truncate response log to 1 KB

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookPayload {
  event:     "tip.received";
  jarId:     string;
  from:      string;
  amount:    string;   // human-readable USDC, e.g. "2.50"
  amountRaw: string;   // stroops as string
  message:   string;
  ledger:    number;
  timestamp: string;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Find all enabled webhooks for the jar's creator and deliver the event.
 * Failures are logged but never thrown — the indexer must not crash on
 * a bad webhook endpoint.
 */
export async function dispatchWebhooks(event: TipEvent): Promise<void> {
  const creator = await db.creator.findUnique({
    where:   { jarId: event.jarId },
    include: { webhooks: { where: { enabled: true } } },
  });

  if (!creator || creator.webhooks.length === 0) return;

  const payload: WebhookPayload = {
    event:     "tip.received",
    jarId:     event.jarId,
    from:      event.from,
    amount:    stroopsToUsdc(event.amount),
    amountRaw: event.amount.toString(),
    message:   event.message,
    ledger:    event.ledger,
    timestamp: event.timestamp,
  };

  const body = JSON.stringify(payload);

  await Promise.allSettled(
    creator.webhooks.map((webhook) => deliver(webhook, body, payload)),
  );
}

async function deliver(
  webhook: { id: string; url: string; secret: string },
  body: string,
  payload: WebhookPayload,
): Promise<void> {
  const signature = sign(body, webhook.secret);

  let statusCode: number | undefined;
  let responseText: string | undefined;
  let success = false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(webhook.url, {
      method:  "POST",
      headers: {
        "Content-Type":        "application/json",
        "X-Novatip-Signature": `sha256=${signature}`,
        "User-Agent":          "Novatip-Webhook/1.0",
      },
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    statusCode   = res.status;
    responseText = (await res.text()).slice(0, MAX_BODY_SIZE);
    success      = res.ok;
  } catch (err) {
    responseText = String(err).slice(0, MAX_BODY_SIZE);
    success      = false;
  }

  // Record delivery attempt
  await db.webhookDelivery.create({
    data: {
      webhookId:  webhook.id,
      statusCode,
      success,
      payload:    payload as object,
      response:   responseText,
    },
  });

  if (!success) {
    console.warn(`[webhook] delivery failed → ${webhook.url} (${statusCode ?? "no response"})`);
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ── CRUD (creator manages their own webhooks) ─────────────────────────────────

export async function createWebhook(creatorId: string, url: string, secret: string) {
  return db.webhook.create({ data: { creatorId, url, secret } });
}

export async function listWebhooks(creatorId: string) {
  return db.webhook.findMany({
    where:  { creatorId },
    select: { id: true, url: true, enabled: true, createdAt: true },
  });
}

export async function deleteWebhook(creatorId: string, webhookId: string) {
  await db.webhook.deleteMany({ where: { id: webhookId, creatorId } });
}
