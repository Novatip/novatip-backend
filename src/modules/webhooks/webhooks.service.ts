/**
 * webhooks.service.ts
 *
 * Dispatches TipReceived events to creator-registered webhook URLs, and sends
 * the on-demand test ping a creator uses to check a receiver before a real tip
 * depends on it.
 *
 * Security: each delivery is signed with HMAC-SHA256 using the webhook's
 * shared secret. The receiving server can verify:
 *   X-Novatip-Signature: sha256=<hex>
 */

import { createHmac, randomBytes } from "crypto";
import { db } from "../../db.js";
import type { TipEvent } from "@novatip/sdk";
import { stroopsToUsdc } from "@novatip/sdk";
import { logger } from "../../utils/logger.js";
import { assertWebhookLimit, webhookLimit } from "./limit.js";

const webhookLogger = logger.child({ component: "webhook" });

const TIMEOUT_MS = 5_000;
const MAX_BODY_SIZE = 1_024; // truncate response log to 1 KB
const MAX_PAYLOAD_SIZE = 2_048; // bound stored delivery payload to 2 KB

/**
 * Reduce the stored payload to a diagnostic minimum when it exceeds
 * MAX_PAYLOAD_SIZE. The full payload is what was sent to the webhook; the
 * stored copy only needs to be large enough to tell what was dispatched.
 * Fields are trimmed in priority order: message first, then amountRaw.
 */
function boundPayload(payload: DeliveryPayload, limit: number): object {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") <= limit) return payload as object;

  // The test ping is fixed-size and cannot reach the limit, so there is
  // nothing to trim and no variable field to trim it from.
  if (payload.event !== "tip.received") return payload as object;

  // Truncate message first — it is the largest variable field.
  const truncated: WebhookPayload = {
    ...payload,
    message: payload.message.slice(0, 200) + "…",
  };
  const reduced = JSON.stringify(truncated);
  if (Buffer.byteLength(reduced, "utf8") <= limit) return truncated as object;

  // Still too large — strip amountRaw as well.
  const stripped: WebhookPayload = { ...truncated, amountRaw: "" };
  return stripped as object;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookPayload {
  event: "tip.received";
  jarId: string;
  from: string;
  amount: string; // human-readable USDC, e.g. "2.50"
  amountRaw: string; // stroops as string
  message: string;
  ledger: number;
  timestamp: string;
}

/**
 * The body of a test ping.
 *
 * Marked as a test twice over, because a receiver can be written either way:
 * one that switches on `event` never matches "tip.received", and one that
 * ignores `event` still sees `test: true`. Neither should book a tip from
 * this. It deliberately carries no amount, sender or jar — there is no
 * plausible tip to be reconstructed from it even by a receiver that tries.
 */
interface TestPingPayload {
  event: "webhook.test";
  test: true;
  webhookId: string;
  timestamp: string;
}

type DeliveryPayload = WebhookPayload | TestPingPayload;

/** What one delivery attempt did, as recorded and as reported to the caller. */
export interface DeliveryOutcome {
  success: boolean;
  statusCode: number | null;
  /** Response body (truncated), or the transport error when there was none. */
  response: string | null;
  attemptedAt: Date;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Find all enabled webhooks for the jar's creator and deliver the event.
 * Failures are logged but never thrown — the indexer must not crash on
 * a bad webhook endpoint.
 */
export async function dispatchWebhooks(event: TipEvent): Promise<void> {
  const creator = await db.creator.findUnique({
    where: { jarId: event.jarId },
    include: { webhooks: { where: { enabled: true } } },
  });

  if (!creator || creator.webhooks.length === 0) return;

  const payload: WebhookPayload = {
    event: "tip.received",
    jarId: event.jarId,
    from: event.from,
    amount: stroopsToUsdc(event.amount),
    amountRaw: event.amount.toString(),
    message: event.message,
    ledger: event.ledger,
    timestamp: event.timestamp,
  };

  const body = JSON.stringify(payload);

  await Promise.allSettled(
    creator.webhooks.map((webhook) => deliver(webhook, body, payload)),
  );
}

/**
 * POST one signed body to one webhook and record the attempt.
 *
 * Never throws: a bad endpoint must not take down the indexer, and the ping
 * route wants the failure as data rather than as an exception. The outcome is
 * returned so the caller can report it — the indexer discards it, the ping
 * route hands it back to the creator.
 */
async function deliver(
  webhook: { id: string; url: string; secret: string },
  body: string,
  payload: DeliveryPayload,
): Promise<DeliveryOutcome> {
  const signature = sign(body, webhook.secret);

  let statusCode: number | undefined;
  let responseText: string | undefined;
  let success = false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Novatip-Signature": `sha256=${signature}`,
        "User-Agent": "Novatip-Webhook/1.0",
      },
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    statusCode = res.status;
    responseText = (await res.text()).slice(0, MAX_BODY_SIZE);
    success = res.ok;
  } catch (err) {
    responseText = String(err).slice(0, MAX_BODY_SIZE);
    success = false;
  }

  // Record delivery attempt
  const attempt = await db.webhookDelivery.create({
    // statusCode and response are nullable columns: a request that timed out or
    // failed to connect genuinely has neither, and NULL records that honestly.
    // An explicit undefined is also rejected under exactOptionalPropertyTypes.
    data: {
      webhookId: webhook.id,
      statusCode: statusCode ?? null,
      success,
      payload: boundPayload(payload, MAX_PAYLOAD_SIZE),
      response: responseText ?? null,
    },
    select: {
      statusCode: true,
      success: true,
      response: true,
      attemptedAt: true,
    },
  });

  if (!success) {
    webhookLogger.warn(
      { url: webhook.url, statusCode: statusCode ?? null },
      "delivery failed",
    );
  }

  // Reported straight from the stored row, so what the creator is told and
  // what the delivery history will show them cannot drift apart.
  return attempt;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ── Test ping ─────────────────────────────────────────────────────────────────

/**
 * Send a signed test payload to one of the caller's webhooks and return what
 * happened. Null means the caller owns no webhook with that id.
 *
 * Without this, a creator finds out their URL is wrong or their signature
 * check is broken by missing a tip notification — the worst possible moment to
 * learn it. The ping uses the same signing and the same delivery path as a
 * real tip, so a receiver that passes here passes for real.
 *
 * A disabled webhook is pinged too. That is the point: pause a broken
 * receiver, fix it, ping to confirm, then re-enable. The `enabled` flag gates
 * automatic dispatch, not an explicit request from the owner.
 *
 * The attempt is recorded like any other, so it also shows up in the delivery
 * history and ages out under the same retention windows.
 */
export async function sendTestPing(
  creatorId: string,
  webhookId: string,
): Promise<DeliveryOutcome | null> {
  const webhook = await db.webhook.findFirst({
    where: { id: webhookId, creatorId },
    // The one place the secret is read back out — it is needed to sign, and
    // never leaves this function.
    select: { id: true, url: true, secret: true },
  });

  if (!webhook) return null;

  const payload: TestPingPayload = {
    event: "webhook.test",
    test: true,
    webhookId: webhook.id,
    timestamp: new Date().toISOString(),
  };

  return deliver(webhook, JSON.stringify(payload), payload);
}

// ── CRUD (creator manages their own webhooks) ─────────────────────────────────

/**
 * The columns a webhook is described by in API responses.
 *
 * `secret` is deliberately absent. It is returned exactly once — in the
 * registration response, and again when it is rotated — and never read back
 * out of a listing or an update, so a leaked access token cannot be turned
 * into the ability to forge signed deliveries.
 */
const webhookSelect = {
  id: true,
  url: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Entropy in a generated signing secret, in bytes. 24 bytes is 192 bits,
 * rendered as 48 hex characters — far past brute force against an HMAC, and
 * still short enough to paste into a receiver's config by hand.
 */
const SECRET_BYTES = 24;

/**
 * Mint a signing secret.
 *
 * Both registration and rotation go through here so there is one definition of
 * what a secret is; a rotation that quietly produced weaker secrets than
 * registration would be invisible until it mattered.
 */
export function generateWebhookSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

/**
 * Register a webhook, rejecting the request once the creator is at the cap.
 *
 * The count and the insert run in one interactive transaction: two concurrent
 * registrations that each read the pre-insert count would otherwise both pass
 * the check and leave the creator one over the limit.
 */
export async function createWebhook(
  creatorId: string,
  url: string,
  secret: string,
) {
  const limit = webhookLimit();

  // No cap configured — skip the extra round trip entirely.
  if (limit === null) {
    return db.webhook.create({ data: { creatorId, url, secret } });
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.webhook.count({ where: { creatorId } });
    assertWebhookLimit(existing, limit);
    return tx.webhook.create({ data: { creatorId, url, secret } });
  });
}

export async function listWebhooks(creatorId: string, limit = 50, offset = 0) {
  return db.webhook.findMany({
    where: { creatorId },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
    select: webhookSelect,
  });
}

/**
 * Flip a webhook's `enabled` flag, returning the updated row or null when the
 * caller does not own a webhook with that id.
 *
 * The write is scoped by creatorId as well as id, so ownership is enforced by
 * the same statement that updates rather than by a read beforehand — there is
 * no window in which the row could change hands in between. A count of 0 means
 * the webhook is missing *or* belongs to someone else; the route answers 404
 * either way, so it never confirms another creator's webhook exists.
 *
 * The secret is untouched. dispatchWebhooks already filters on `enabled`, so
 * disabling stops deliveries immediately and re-enabling resumes them with the
 * secret the receiver already holds — no re-registration, no new secret.
 */
export async function setWebhookEnabled(
  creatorId: string,
  webhookId: string,
  enabled: boolean,
) {
  const { count } = await db.webhook.updateMany({
    where: { id: webhookId, creatorId },
    data: { enabled },
  });

  if (count === 0) return null;

  return db.webhook.findUnique({
    where: { id: webhookId },
    select: webhookSelect,
  });
}

// ── Delivery history ──────────────────────────────────────────────────────────

/** Page size used when the caller does not ask for one. */
export const DEFAULT_DELIVERY_PAGE_SIZE = 20;

/**
 * Hard ceiling on a delivery page. Each row carries up to 1 KB of response
 * body, so an unbounded page over a busy webhook is a multi-megabyte response
 * assembled in memory — the cap is what keeps this endpoint cheap.
 */
export const MAX_DELIVERY_PAGE_SIZE = 100;

/**
 * The columns a delivery attempt is reported by.
 *
 * `payload` is omitted. It is what the server sent, which the creator already
 * knows the shape of, and it is the largest column in the row; what they
 * cannot otherwise see is what came *back*, which is `statusCode` and
 * `response`.
 */
const deliverySelect = {
  id: true,
  statusCode: true,
  success: true,
  response: true,
  attemptedAt: true,
} as const;

/**
 * Recent delivery attempts for one webhook, newest first.
 *
 * Returns null — not an empty array — when the caller owns no webhook with
 * that id, so the route can answer 404 rather than conflating "not yours"
 * with "nothing delivered yet".
 *
 * Ownership is established by reading the webhook first. WebhookDelivery
 * carries no creatorId of its own, and a webhook never changes hands (no route
 * writes creatorId), so the check cannot go stale between the two statements.
 *
 * `response` is already bounded to 1 KB at write time (MAX_BODY_SIZE in
 * deliver), so rows are returned as stored.
 */
export async function listWebhookDeliveries(
  creatorId: string,
  webhookId: string,
  limit = DEFAULT_DELIVERY_PAGE_SIZE,
  offset = 0,
) {
  const owned = await db.webhook.findFirst({
    where: { id: webhookId, creatorId },
    select: { id: true },
  });

  if (!owned) return null;

  return db.webhookDelivery.findMany({
    where: { webhookId },
    orderBy: { attemptedAt: "desc" },
    take: Math.min(limit, MAX_DELIVERY_PAGE_SIZE),
    skip: offset,
    select: deliverySelect,
  });
}

// ── Secret rotation ───────────────────────────────────────────────────────────

/**
 * Replace a webhook's signing secret, returning the webhook and the new secret
 * — once. Null means the caller owns no webhook with that id.
 *
 * The secret was previously minted once at registration and shown in that one
 * response, so a leaked or lost secret could only be dealt with by deleting
 * the webhook and creating another. That changes the id and discards the
 * delivery history, which is a lot to give up to replace a credential.
 *
 * Rotation writes nothing but `secret`: the id, URL, enabled flag and every
 * WebhookDelivery row survive untouched. dispatchWebhooks reads the secret per
 * dispatch, so the next delivery is signed with the new one with no restart
 * and no cache to invalidate.
 *
 * There is no overlap window where both secrets are accepted — the signature
 * is computed by us and verified by the receiver, so the cutover is whenever
 * the receiver updates its copy. A creator rotating a *leaked* secret wants
 * the old one dead immediately, which is the stronger requirement; a creator
 * rotating routinely can disable the webhook first (PATCH /webhooks/:id),
 * update both sides, then re-enable.
 *
 * `secret` accepts a caller-supplied value for symmetry with registration, so
 * choosing your own secret does not require the delete-and-recreate this
 * route exists to avoid.
 */
export async function rotateWebhookSecret(
  creatorId: string,
  webhookId: string,
  secret: string = generateWebhookSecret(),
) {
  const { count } = await db.webhook.updateMany({
    where: { id: webhookId, creatorId },
    data: { secret },
  });

  if (count === 0) return null;

  const webhook = await db.webhook.findUnique({
    where: { id: webhookId },
    select: webhookSelect,
  });

  if (webhook === null) return null;

  // Returned alongside the webhook exactly as registration does it, and for
  // the same reason: this is the only time it is readable.
  return { ...webhook, secret };
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
