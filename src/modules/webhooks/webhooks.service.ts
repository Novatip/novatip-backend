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
import { logger } from "../../utils/logger.js";

const webhookLogger = logger.child({ component: "webhook" });

const TIMEOUT_MS    = 5_000;
const MAX_BODY_SIZE = 1_024;   // truncate response log to 1 KB
const MAX_PAYLOAD_SIZE = 2_048; // bound stored delivery payload to 2 KB

/**
 * Reduce the stored payload to a diagnostic minimum when it exceeds
 * MAX_PAYLOAD_SIZE. The full payload is what was sent to the webhook; the
 * stored copy only needs to be large enough to tell what was dispatched.
 * Fields are trimmed in priority order: message first, then amountRaw.
 */
function boundPayload(payload: WebhookPayload, limit: number): object {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") <= limit) return payload as object;

  // Truncate message first — it is the largest variable field.
  const truncated: WebhookPayload = { ...payload, message: payload.message.slice(0, 200) + "…" };
  let reduced = JSON.stringify(truncated);
  if (Buffer.byteLength(reduced, "utf8") <= limit) return truncated as object;

  // Still too large — strip amountRaw as well.
  const stripped: WebhookPayload = { ...truncated, amountRaw: "" };
  return stripped as object;
}

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
    // statusCode and response are nullable columns: a request that timed out or
    // failed to connect genuinely has neither, and NULL records that honestly.
    // An explicit undefined is also rejected under exactOptionalPropertyTypes.
    data: {
      webhookId:  webhook.id,
      statusCode: statusCode ?? null,
      success,
      payload:    payload as object,
      response:   responseText ?? null,
    },
  });

  if (!success) {
    webhookLogger.warn(
      { url: webhook.url, statusCode: statusCode ?? null },
      "delivery failed",
    );
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ── CRUD (creator manages their own webhooks) ─────────────────────────────────

export async function createWebhook(creatorId: string, url: string, secret: string) {
  return db.webhook.create({ data: { creatorId, url, secret } });
}

export async function listWebhooks(creatorId: string, limit = 50, offset = 0) {
  return db.webhook.findMany({
    where:  { creatorId },
    orderBy: { createdAt: "desc" },
    take:   limit,
    skip:   offset,
    select: { id: true, url: true, enabled: true, createdAt: true },
  });
}

export async function deleteWebhook(
  creatorId: string,
  webhookId: string,
): Promise<boolean> {
  const { count } = await db.webhook.deleteMany({
    where: { id: webhookId, creatorId },
  });
  return count > 0;
}
