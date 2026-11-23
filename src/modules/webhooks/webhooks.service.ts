/**
 * webhooks.service.ts
 *
 * Dispatches TipReceived events to creator-registered webhook URLs, and sends
 * the on-demand test ping a creator uses to check a receiver before a real tip
 * depends on it.
 *
 * Security: each delivery is signed with HMAC-SHA256 using the webhook's
 * shared secret and a timestamp to protect against replay attacks:
 *   X-Novatip-Signature: sha256=<hex>
 *   X-Novatip-Timestamp: <unix-timestamp-in-seconds>
 * Signed material: `${timestamp}.${body}`
 */

import { createHmac, randomBytes } from "crypto";
import { db } from "../../db.js";
import { config } from "../../config.js";
import type { TipEvent } from "@novatip/sdk";
import { stroopsToUsdc } from "@novatip/sdk";
import { logger } from "../../utils/logger.js";
import { assertWebhookLimit, webhookLimit } from "./limit.js";
import { notifyWebhookFailure } from "../notifications/webhook-failure.service.js";
import {
  recordWebhookDecryptError,
  recordWebhookDelivery,
  recordWebhookDuration,
} from "../metrics/metrics.service.js";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  isEncryptedWebhookSecret,
  parseWebhookEncryptionKey,
} from "./secret-crypto.js";
import {
  assertWebhookDestinationAllowed,
  assertWebhookUrlForRegistration,
} from "./webhook-url.js";
import { postWebhook } from "./webhook-request.js";

const webhookLogger = logger.child({ component: "webhook" });

/**
 * Reduce the stored payload to a diagnostic minimum when it exceeds
 * MAX_PAYLOAD_SIZE. The full payload is what was sent to the webhook; the
 * stored copy only needs to be large enough to tell what was dispatched.
 * Fields are trimmed in priority order: message first, then amountRaw.
 */
function boundPayload(payload: DeliveryPayload, limit: number): object {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") <= limit) return payload as object;

  const diagnostic = { event: payload.event, truncated: true };
  if (Buffer.byteLength(JSON.stringify(diagnostic), "utf8") <= limit) {
    return diagnostic;
  }

  if (payload.event !== "tip.received") {
    return {};
  }

  // Truncate message first — it is the largest variable field.
  const truncated: WebhookPayload = {
    ...payload,
    message: payload.message.slice(0, 200) + "…",
  };
  const reduced = JSON.stringify(truncated);
  if (Buffer.byteLength(reduced, "utf8") <= limit) return truncated as object;

  // Still too large — strip amountRaw as well.
  const stripped: WebhookPayload = { ...truncated, amountRaw: "" };
  if (Buffer.byteLength(JSON.stringify(stripped), "utf8") <= limit) {
    return stripped as object;
  }

  return {};
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
  txHash: string;
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

interface DeliveryQueueJob {
  run: () => Promise<DeliveryOutcome>;
  resolve: (outcome: DeliveryOutcome) => void;
  reject: (reason: unknown) => void;
}

const deliveryQueue: DeliveryQueueJob[] = [];
const deliveryQueueIdleWaiters: Array<() => void> = [];
let activeDeliveries = 0;
let activeDispatches = 0;

function resolveDeliveryQueueIdle(): void {
  if (
    activeDispatches !== 0 ||
    activeDeliveries !== 0 ||
    deliveryQueue.length !== 0
  ) {
    return;
  }

  for (const resolve of deliveryQueueIdleWaiters.splice(0)) resolve();
}

function processDeliveryQueue(): void {
  while (
    activeDeliveries < config.webhooks.deliveryConcurrency &&
    deliveryQueue.length > 0
  ) {
    const job = deliveryQueue.shift()!;
    activeDeliveries += 1;
    void job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeDeliveries -= 1;
        processDeliveryQueue();
        resolveDeliveryQueueIdle();
      });
  }

  resolveDeliveryQueueIdle();
}

function queueDelivery(
  webhook: { id: string; url: string },
  body: string,
  payload: DeliveryPayload,
): Promise<DeliveryOutcome> {
  return new Promise((resolve, reject) => {
    deliveryQueue.push({
      run: () => deliver(webhook, body, payload),
      resolve,
      reject,
    });
    processDeliveryQueue();
  });
}

/**
 * Wait until queued dispatches and all their deliveries have completed.
 * Used during shutdown before the database connection is closed.
 */
export function drainWebhookDeliveries(): Promise<void> {
  if (
    activeDispatches === 0 &&
    activeDeliveries === 0 &&
    deliveryQueue.length === 0
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => deliveryQueueIdleWaiters.push(resolve));
}

/**
 * Start dispatching a tip without holding up the indexer event loop.
 * Background errors are logged; the delivery queue is drained on shutdown.
 */
export function enqueueWebhookDispatch(event: TipEvent): void {
  activeDispatches += 1;
  void dispatchWebhooks(event)
    .catch((err: unknown) => {
      webhookLogger.error(
        { err, txHash: event.txHash },
        "webhook dispatch failed",
      );
    })
    .finally(() => {
      activeDispatches -= 1;
      resolveDeliveryQueueIdle();
    });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Find all enabled webhooks for the jar's creator and deliver the event.
 *
 * Two gates, both of which must pass: the creator-level webhookEnabled
 * switch — a creator who turned webhooks off in preferences gets nothing
 * attempted at all — and the per-webhook `enabled` filter in the include
 * below, which applies underneath that switch rather than instead of it.
 *
 * Endpoint failures become failed outcomes, and each failed delivery raises
 * a (rate-limited) WEBHOOK_FAILED notification. Unexpected dispatch errors
 * are logged by enqueueWebhookDispatch.
 */
export async function dispatchWebhooks(event: TipEvent): Promise<void> {
  const creator = await db.creator.findUnique({
    where: { jarId: event.jarId },
    include: { webhooks: { where: { enabled: true } } },
  });

  // The creator-level switch is checked before anything else is considered:
  // while webhookEnabled is false, even the enabled endpoints above stay
  // undelivered.
  if (!creator || !creator.webhookEnabled || creator.webhooks.length === 0) {
    return;
  }

  const payload: WebhookPayload = {
    event: "tip.received",
    jarId: event.jarId,
    from: event.from,
    amount: stroopsToUsdc(event.amount),
    amountRaw: event.amount.toString(),
    message: event.message,
    ledger: event.ledger,
    timestamp: event.timestamp,
    txHash: event.txHash,
  };

  const body = JSON.stringify(payload);

  await Promise.all(
    creator.webhooks.map(async (webhook) => {
      let outcome: DeliveryOutcome;
      try {
        outcome = await queueDelivery(webhook, body, payload);
      } catch (err) {
        webhookLogger.error(
          { err, webhookId: webhook.id },
          "webhook delivery failed unexpectedly",
        );
        outcome = {
          success: false,
          statusCode: null,
          response: null,
          attemptedAt: new Date(),
        };
      }

      if (!outcome.success) {
        await notifyWebhookFailure(creator.id, {
          webhookId: webhook.id,
          url: webhook.url,
          statusCode: outcome.statusCode,
        });
      }
    }),
  );
}

/**
 * POST one signed body to one webhook and record the attempt.
 *
 * Endpoint and delivery-row write failures are returned as failed outcomes.
 * Unexpected errors may still propagate to callers.
 */
async function deliver(
  webhook: { id: string; url: string },
  body: string,
  payload: DeliveryPayload,
): Promise<DeliveryOutcome> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const startTime = Date.now();

  // The secret is read now, at send time, never carried in the queued job: a
  // rotation between enqueue and send must sign with the new secret. Both
  // dispatch and the test ping go through here.
  let secret: string;
  try {
    const current = await db.webhook.findUnique({
      where: { id: webhook.id },
      select: { secret: true },
    });
    if (!current) {
      // Deleted while queued: nothing to sign with and no row to record on.
      return {
        statusCode: null,
        success: false,
        response: "WEBHOOK_NOT_FOUND",
        attemptedAt: new Date(startTime),
      };
    }
    secret = decryptWebhookSecret(current.secret, getWebhookEncryptionKey());
  } catch (err) {
    webhookLogger.error(
      { err, webhookId: webhook.id },
      "failed to decrypt webhook secret",
    );
    recordWebhookDecryptError();
    recordWebhookDelivery("failure");
    recordWebhookDuration((Date.now() - startTime) / 1000);

    let attempt: DeliveryOutcome | undefined;
    try {
      attempt = await db.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          statusCode: null,
          success: false,
          payload: boundPayload(payload, config.webhooks.maxPayloadSize),
          response: WEBHOOK_SECRET_DECRYPT_FAILED_CODE,
        },
        select: {
          statusCode: true,
          success: true,
          response: true,
          attemptedAt: true,
        },
      });
    } catch (recordErr) {
      webhookLogger.error(
        { err: recordErr, webhookId: webhook.id },
        "failed to record webhook delivery",
      );
    }

    return (
      attempt ?? {
        statusCode: null,
        success: false,
        response: WEBHOOK_SECRET_DECRYPT_FAILED_CODE,
        attemptedAt: new Date(startTime),
      }
    );
  }

  let statusCode: number | undefined;
  let responseText: string | undefined;
  let success = false;
  let timer: NodeJS.Timeout | undefined;

  try {
    const destination = await assertWebhookDestinationAllowed(webhook.url);
    const signature = sign(body, secret, timestamp);
    const controller = new AbortController();
    timer = setTimeout(
      () => controller.abort(),
      config.webhooks.timeoutMs,
    );

    // Delivery does not follow redirects (redirect: "manual"). Webhook URLs are
    // validated as HTTPS upon registration, but following redirects allows an
    // endpoint to answer 301/302 to an insecure HTTP URL or internal network
    // destination (SSRF), carrying the signed payload with it. A redirect is
    // captured with its 3xx status code and recorded as a failed delivery.
    const res = await postWebhook(
      webhook.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Novatip-Signature": `sha256=${signature}`,
          "X-Novatip-Timestamp": timestamp,
          "User-Agent": "Novatip-Webhook/1.0",
        },
        body,
        signal: controller.signal,
        redirect: "manual",
      },
      destination,
    );

    statusCode = res.status;
    responseText = await readResponseBody(
      res,
      config.webhooks.maxBodySize,
      controller.signal,
    );
    success = res.ok;
  } catch (err) {
    responseText = truncateUtf8(String(err), config.webhooks.maxBodySize);
    success = false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // Record delivery attempt
  let attempt: DeliveryOutcome | undefined;
  try {
    attempt = await db.webhookDelivery.create({
      // statusCode and response are nullable columns: a request that timed out or
      // failed to connect genuinely has neither, and NULL records that honestly.
      // An explicit undefined is also rejected under exactOptionalPropertyTypes.
      data: {
        webhookId: webhook.id,
        statusCode: statusCode ?? null,
        success,
        payload: boundPayload(payload, config.webhooks.maxPayloadSize),
        response: responseText ?? null,
      },
      select: {
        statusCode: true,
        success: true,
        response: true,
        attemptedAt: true,
      },
    });
  } catch (err) {
    success = false;
    webhookLogger.error(
      { err, webhookId: webhook.id },
      "failed to record webhook delivery",
    );
  }

  recordWebhookDuration((Date.now() - startTime) / 1000);
  recordWebhookDelivery(success ? "success" : "failure");

  if (!success) {
    webhookLogger.warn(
      {
        webhookId: webhook.id,
        url: webhook.url,
        statusCode: statusCode ?? null,
      },
      "delivery failed",
    );
  }

  if (attempt === undefined) {
    return {
      statusCode: statusCode ?? null,
      success: false,
      response: responseText ?? null,
      attemptedAt: new Date(startTime),
    };
  }

  // Reported straight from the stored row, so what the creator is told and
  // what the delivery history will show them cannot drift apart.
  return attempt;
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const responseBody = (
    response as { body?: ReadableStream<Uint8Array> | null }
  ).body;
  if (responseBody === undefined) {
    const text = await response.text();
    return truncateUtf8(text, maxBytes);
  }

  const reader = responseBody?.getReader();
  if (reader === undefined) return "";

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;
  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => {
      void reader.cancel(signal.reason).catch((err: unknown) => {
        webhookLogger.warn({ err }, "failed to cancel webhook response body");
      });
      reject(signal.reason);
    };
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    if (maxBytes <= 0) {
      truncated = true;
    } else {
      while (bytesRead < maxBytes) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;

        const remaining = maxBytes - bytesRead;
        const chunk = value.subarray(0, remaining);
        chunks.push(chunk);
        bytesRead += chunk.byteLength;

        if (value.byteLength > remaining || bytesRead === maxBytes) {
          truncated = true;
          break;
        }
      }
    }
  } finally {
    if (abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
    if (truncated) {
      void reader.cancel().catch((err: unknown) => {
        webhookLogger.warn({ err }, "failed to cancel webhook response body");
      });
    }
  }

  const decoded = new TextDecoder().decode(Buffer.concat(chunks, bytesRead), {
    stream: truncated,
  });
  return truncateUtf8(decoded, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  const truncated = encoded.byteLength > maxBytes;
  return new TextDecoder().decode(encoded.subarray(0, maxBytes), {
    stream: truncated,
  });
}

/**
 * Compute HMAC-SHA256 signature for a webhook delivery.
 * The signed material is `${timestamp}.${body}`, preventing replay attacks.
 */
export function sign(
  body: string,
  secret: string,
  timestamp: string | number,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
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
    // The secret is deliberately not read here: deliver() fetches it at send
    // time so a rotation while the ping is queued is honoured.
    select: { id: true, url: true },
  });

  if (!webhook) return null;

  const payload: TestPingPayload = {
    event: "webhook.test",
    test: true,
    webhookId: webhook.id,
    timestamp: new Date().toISOString(),
  };

  return queueDelivery(webhook, JSON.stringify(payload), payload);
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

function getWebhookEncryptionKey(): Buffer {
  return parseWebhookEncryptionKey(config.webhooks.encryptionKey);
}

/**
 * Encrypt legacy webhook secrets before the server starts serving requests.
 * The compare-and-set update makes concurrent startup migrations safe.
 */
export async function migrateWebhookSecrets(): Promise<number> {
  const rows = await db.webhook.findMany({
    select: { id: true, secret: true },
  });
  const legacyRows = rows.filter(
    (row) => !isEncryptedWebhookSecret(row.secret),
  );
  if (legacyRows.length === 0) return 0;

  const key = getWebhookEncryptionKey();
  let migrated = 0;
  for (const row of legacyRows) {
    const result = await db.webhook.updateMany({
      where: { id: row.id, secret: row.secret },
      data: { secret: encryptWebhookSecret(row.secret, key) },
    });
    migrated += result.count;
  }

  webhookLogger.info({ migrated }, "encrypted legacy webhook secrets");
  return migrated;
}

/**
 * error.code / response identifier recorded when webhook secret decryption fails.
 */
export const WEBHOOK_SECRET_DECRYPT_FAILED_CODE = "WEBHOOK_SECRET_DECRYPT_FAILED";

/**
 * Rotate encryption key for all encrypted webhook secrets.
 * Decrypts existing secrets using `oldKey` and re-encrypts them using `newKey`
 * (defaults to the currently configured WEBHOOK_ENCRYPTION_KEY).
 */
export async function rotateWebhookSecrets(
  oldKeyInput: Buffer | string,
  newKeyInput?: Buffer | string,
): Promise<{ total: number; rotated: number; failed: number }> {
  const oldKey =
    typeof oldKeyInput === "string"
      ? parseWebhookEncryptionKey(oldKeyInput)
      : oldKeyInput;
  const newKey =
    newKeyInput !== undefined
      ? typeof newKeyInput === "string"
        ? parseWebhookEncryptionKey(newKeyInput)
        : newKeyInput
      : getWebhookEncryptionKey();

  const rows = await db.webhook.findMany({
    select: { id: true, secret: true },
  });

  let rotated = 0;
  let failed = 0;
  for (const row of rows) {
    if (!isEncryptedWebhookSecret(row.secret)) {
      continue;
    }
    try {
      const plaintext = decryptWebhookSecret(row.secret, oldKey);
      const reencrypted = encryptWebhookSecret(plaintext, newKey);
      const result = await db.webhook.updateMany({
        where: { id: row.id, secret: row.secret },
        data: { secret: reencrypted },
      });
      rotated += result.count;
    } catch (err) {
      failed++;
      webhookLogger.error(
        { err, webhookId: row.id },
        "failed to re-encrypt webhook secret during key rotation",
      );
    }
  }

  webhookLogger.info(
    { total: rows.length, rotated, failed },
    "completed webhook secret key rotation",
  );
  return { total: rows.length, rotated, failed };
}

/**
 * error.code on the rejection, so clients can branch on it.
 */
export const WEBHOOK_SECRET_TOO_SHORT_CODE = "WEBHOOK_SECRET_TOO_SHORT";

/**
 * Floor on a caller-supplied signing secret. The signature is the only thing
 * telling a receiver a delivery really came from Novatip, so a one-character
 * secret would make that guarantee worthless against even a casual guess.
 * Below this, the route rejects the request rather than the service writing
 * a secret too weak to trust — checked here, not only in the route's input
 * schema, so nothing that calls createWebhook or rotateWebhookSecret directly
 * can skip it.
 */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

function assertSecretLength(secret: string): void {
  if (secret.length >= MIN_WEBHOOK_SECRET_LENGTH) return;

  throw Object.assign(
    new Error(
      `Webhook secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} ` +
        `characters long.`,
    ),
    { statusCode: 400, code: WEBHOOK_SECRET_TOO_SHORT_CODE },
  );
}

/**
 * Register a webhook, rejecting the request once the creator is at the cap.
 *
 * The creator row lock makes the count and insert serial per creator under
 * READ COMMITTED, so concurrent registrations cannot both pass a stale count.
 */
export async function createWebhook(
  creatorId: string,
  url: string,
  secret: string,
) {
  assertSecretLength(secret);
  assertWebhookUrlForRegistration(url);
  const encryptedSecret = encryptWebhookSecret(
    secret,
    getWebhookEncryptionKey(),
  );

  const limit = webhookLimit();

  // No cap configured — skip the extra round trip entirely.
  if (limit === null) {
    return db.webhook.create({
      data: { creatorId, url, secret: encryptedSecret },
    });
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "Creator" WHERE "id" = ${creatorId} FOR UPDATE
    `;
    const existing = await tx.webhook.count({ where: { creatorId } });
    assertWebhookLimit(existing, limit);
    return tx.webhook.create({
      data: { creatorId, url, secret: encryptedSecret },
    });
  });
}

/** Page size used when the caller does not ask for one. */
export const DEFAULT_WEBHOOK_PAGE_SIZE = 50;

/** Hard ceiling on a webhook-list page. */
export const MAX_WEBHOOK_PAGE_SIZE = 100;

export async function listWebhooks(
  creatorId: string,
  limit = DEFAULT_WEBHOOK_PAGE_SIZE,
  offset = 0,
) {
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
  successFilter?: boolean,
) {
  const owned = await db.webhook.findFirst({
    where: { id: webhookId, creatorId },
    select: { id: true },
  });

  if (!owned) return null;

  const where = successFilter !== undefined
    ? { webhookId, success: successFilter }
    : { webhookId };

  return db.webhookDelivery.findMany({
    where,
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
 * WebhookDelivery row survive untouched. deliver() reads the secret at send
 * time, so any delivery not yet sent — even one already queued — is signed with
 * the new one with no restart and no cache to invalidate.
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
  assertSecretLength(secret);

  const { count } = await db.webhook.updateMany({
    where: { id: webhookId, creatorId },
    data: {
      secret: encryptWebhookSecret(secret, getWebhookEncryptionKey()),
    },
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
  return db.$transaction(async (tx) => {
    const webhook = await tx.webhook.findFirst({
      where: { id: webhookId, creatorId },
      select: { id: true },
    });
    if (!webhook) return false;

    await tx.webhookDelivery.deleteMany({ where: { webhookId } });
    const { count } = await tx.webhook.deleteMany({
      where: { id: webhookId, creatorId },
    });
    return count > 0;
  });
}
