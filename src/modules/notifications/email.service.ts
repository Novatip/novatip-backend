/**
 * notifications/email.service.ts
 *
 * Tip notification emails via Resend. Individual emails are capped per
 * creator and UTC clock hour; suppressed tips are stored and sent together
 * in one digest after that hour closes.
 */

import type { TipEvent } from "@novatip/sdk";
import { formatUsdc } from "@novatip/sdk";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { escapeHtml } from "../../utils/html.js";

const emailLogger = logger.child({ component: "notifications" });
const HOUR_MS = 60 * 60 * 1000;
const DIGEST_POLL_INTERVAL_MS = 60_000;

interface TipEmailCreator {
  id: string;
  slug: string;
  displayName: string | null;
  email: string | null;
  emailVerifiedAt: Date | null;
}

async function deliverEmail(
  creator: TipEmailCreator & { email: string },
  subject: string,
  text: string,
  html: string,
): Promise<boolean> {
  const { Resend } = await import("resend");
  const resend = new Resend(config.resend.apiKey);
  const { error } = await resend.emails.send({
    from: config.resend.from,
    to: [creator.email],
    subject,
    text,
    html,
  });

  if (error) {
    emailLogger.error({ err: error }, "Resend rejected the email");
    return false;
  }
  return true;
}

function tipPayload(event: TipEvent) {
  return {
    from: event.from,
    amount: event.amount.toString(),
    message: event.message,
    ledger: event.ledger,
    timestamp: event.timestamp,
    txHash: event.txHash,
  };
}

function tipEmailContent(
  creator: TipEmailCreator,
  event: TipEvent,
): { subject: string; text: string; html: string } {
  const amount = formatUsdc(event.amount, 2);
  const displayName = creator.displayName ?? creator.slug;
  const message = event.message ? `"${event.message}"` : "No message left.";
  const htmlMessage = event.message
    ? `"${escapeHtml(event.message)}"`
    : "No message left.";

  return {
    subject: `💸 You received $${amount} USDC on Novatip!`,
    text: [
      `Hey ${displayName}!`,
      "",
      `Someone just tipped you $${amount} USDC on Novatip.`,
      "",
      message,
      "",
      `View your dashboard: ${config.appBaseUrl}/dashboard`,
    ].join("\n"),
    html: `
      <h2>Hey ${escapeHtml(displayName)}!</h2>
      <p>
        Someone just tipped you <strong>$${escapeHtml(amount)} USDC</strong> on Novatip.
      </p>
      <p><em>${htmlMessage}</em></p>
      <p>
        <a href="${config.appBaseUrl}/dashboard">View your dashboard →</a>
      </p>
    `,
  };
}

export async function sendEmailVerificationEmail(
  email: string,
  confirmationUrl: string,
): Promise<void> {
  if (!config.resend.apiKey) {
    throw Object.assign(new Error("Email delivery is not configured."), {
      statusCode: 503,
      code: "EMAIL_DELIVERY_UNAVAILABLE",
    });
  }

  const { Resend } = await import("resend");
  const resend = new Resend(config.resend.apiKey);
  const { error } = await resend.emails.send({
    from: config.resend.from,
    to: [email],
    subject: "Confirm your Novatip notification email",
    text: `Confirm your notification email by visiting: ${confirmationUrl}\n\nThis link expires in 24 hours.`,
    html: `<p>Confirm your notification email by clicking the link below. This link expires in 24 hours.</p><p><a href="${escapeHtml(confirmationUrl)}">Confirm email address</a></p>`,
  });

  if (error) {
    emailLogger.error({ err: error }, "Resend rejected the verification email");
    throw Object.assign(
      new Error("Could not send the email verification message."),
      { statusCode: 502, code: "EMAIL_DELIVERY_FAILED" },
    );
  }
}

/**
 * Send an individual tip email while the creator is under their hourly cap.
 * The pending notification is stored before sending, so capped or temporarily
 * failed sends remain available for the hourly digest.
 */
export async function sendTipNotification(event: TipEvent): Promise<void> {
  try {
    const creator = await db.creator.findUnique({
      where: { jarId: event.jarId },
    });
    if (!creator) return;

    const notification = await db.notification.create({
      data: {
        creatorId: creator.id,
        type: "TIP_RECEIVED",
        payload: tipPayload(event),
      },
      select: { id: true },
    });

    if (!config.resend.apiKey) return;
    if (!creator.emailEnabled) {
      emailLogger.debug(
        { slug: creator.slug },
        "creator has email notifications switched off — skipping tip notification",
      );
      return;
    }
    if (!creator.email) {
      emailLogger.debug(
        { slug: creator.slug },
        "creator has no email on record — skipping tip notification",
      );
      return;
    }
    if (!creator.emailVerifiedAt) {
      emailLogger.debug(
        { slug: creator.slug },
        "creator email is not verified — skipping tip notification",
      );
      return;
    }

    const now = new Date();
    const windowStart = new Date(
      Math.floor(now.getTime() / HOUR_MS) * HOUR_MS,
    );
    const windowEnd = new Date(windowStart.getTime() + HOUR_MS);
    const sentThisWindow = await db.notification.count({
      where: {
        creatorId: creator.id,
        type: "TIP_RECEIVED",
        createdAt: { gte: windowStart, lt: windowEnd },
        sentAt: { not: null },
      },
    });

    if (sentThisWindow >= config.notifications.emailMaxPerCreatorPerHour) {
      emailLogger.debug(
        { slug: creator.slug, windowStart },
        "tip email cap reached — queued for hourly digest",
      );
      return;
    }

    const content = tipEmailContent(creator, event);
    const delivered = await deliverEmail(
      creator,
      content.subject,
      content.text,
      content.html,
    );

    if (delivered) {
      await db.notification.update({
        where: { id: notification.id },
        data: { sentAt: new Date() },
      });
    }
  } catch (err) {
    emailLogger.error({ err }, "failed to record or send tip notification");
  }
}

/**
 * Send one digest per creator and UTC clock hour for all pending tip rows in
 * closed windows. Failed sends remain pending and are retried on the next run.
 */
export async function sendPendingTipDigests(
  now: Date = new Date(),
): Promise<number> {
  if (!config.resend.apiKey) return 0;

  const currentWindowStart = new Date(
    Math.floor(now.getTime() / HOUR_MS) * HOUR_MS,
  );
  const pending = await db.notification.findMany({
    where: {
      type: "TIP_RECEIVED",
      sentAt: null,
      createdAt: { lt: currentWindowStart },
    },
    select: { id: true, creatorId: true, createdAt: true, payload: true },
  });

  const groups = new Map<string, typeof pending>();
  for (const row of pending) {
    const windowStartMs =
      Math.floor(row.createdAt.getTime() / HOUR_MS) * HOUR_MS;
    const key = `${row.creatorId}:${windowStartMs}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  let digestsSent = 0;
  for (const rows of groups.values()) {
    const first = rows[0];
    if (!first) continue;

    try {
      const creator = await db.creator.findUnique({
        where: { id: first.creatorId },
      });
      if (!creator?.emailEnabled || !creator.email) continue;
      if (!creator.emailVerifiedAt) {
        emailLogger.debug(
          { slug: creator.slug },
          "creator email is not verified — skipping tip digest",
        );
        continue;
      }

      let totalAmount = 0n;
      for (const row of rows) {
        if (
          typeof row.payload !== "object" ||
          row.payload === null ||
          !("amount" in row.payload) ||
          typeof row.payload.amount !== "string" ||
          !/^\d+$/.test(row.payload.amount)
        ) {
          throw new Error(`Invalid tip amount in notification ${row.id}`);
        }
        totalAmount += BigInt(row.payload.amount);
      }

      const displayName = creator.displayName ?? creator.slug;
      const total = formatUsdc(totalAmount, 2);
      const count = rows.length;
      const windowStartMs =
        Math.floor(first.createdAt.getTime() / HOUR_MS) * HOUR_MS;
      const windowStartAt = new Date(windowStartMs);
      const windowEndAt = new Date(windowStartMs + HOUR_MS);
      const windowStart = windowStartAt.toISOString();
      const windowEnd = windowEndAt.toISOString();
      const subject = `💸 You received ${count} tips on Novatip!`;
      const text = [
        `Hey ${displayName}!`,
        "",
        `You received ${count} tips totaling $${total} USDC on Novatip.`,
        `Digest window: ${windowStart} – ${windowEnd}`,
        "",
        `View your dashboard: ${config.appBaseUrl}/dashboard`,
      ].join("\n");
      const html = `
        <h2>Hey ${escapeHtml(displayName)}!</h2>
        <p>
          You received <strong>${count} tips totaling $${escapeHtml(total)} USDC</strong>
          on Novatip.
        </p>
        <p>Digest window: ${windowStart} – ${windowEnd}</p>
        <p>
          <a href="${config.appBaseUrl}/dashboard">View your dashboard →</a>
        </p>
      `;

      const delivered = await deliverEmail(
        creator,
        subject,
        text,
        html,
      );
      if (!delivered) continue;

      await db.notification.updateMany({
        where: {
          creatorId: first.creatorId,
          type: "TIP_RECEIVED",
          createdAt: { gte: windowStartAt, lt: windowEndAt },
          sentAt: null,
        },
        data: { sentAt: now },
      });
      digestsSent += 1;
    } catch (err) {
      emailLogger.error(
        { err, creatorId: first.creatorId },
        "failed to send tip digest",
      );
    }
  }

  return digestsSent;
}

let digestTimer: NodeJS.Timeout | null = null;
let digestActive = false;

/** Start the background digest sender. Safe to call once at server startup. */
export function startTipDigestScheduler(): void {
  if (digestTimer !== null || digestActive) return;
  if (!config.resend.apiKey) return;

  digestActive = true;
  scheduleDigest(DIGEST_POLL_INTERVAL_MS);
}

/** Stop the background digest sender during server shutdown. */
export function stopTipDigestScheduler(): void {
  digestActive = false;
  if (digestTimer !== null) {
    clearTimeout(digestTimer);
    digestTimer = null;
  }
}

function scheduleDigest(delayMs: number): void {
  digestTimer = setTimeout(() => {
    void runDigest();
  }, delayMs);
  digestTimer.unref();
}

async function runDigest(): Promise<void> {
  if (!digestActive) return;

  try {
    await sendPendingTipDigests();
  } catch (err) {
    emailLogger.error({ err }, "tip digest pass failed");
  }

  if (digestActive) scheduleDigest(DIGEST_POLL_INTERVAL_MS);
}
