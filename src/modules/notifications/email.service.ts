/**
 * notifications/email.service.ts
 *
 * Email notification stub using Resend (https://resend.com).
 *
 * Sends a "You received a tip!" email to the creator after each indexed tip.
 * Silently skips if RESEND_API_KEY is not configured (local dev default).
 */

import type { TipEvent } from "@novatip/sdk";
import { formatUsdc } from "@novatip/sdk";
import { db } from "../../db.js";
import { config } from "../../config.js";

/**
 * Send a tip-received email notification to the creator.
 * Fails silently if Resend is not configured or the creator has no email.
 */
export async function sendTipNotification(event: TipEvent): Promise<void> {
  if (!config.resend.apiKey) return; // not configured — skip

  const creator = await db.creator.findUnique({
    where: { jarId: event.jarId },
  });

  if (!creator) return;

  // TODO: add a creator email field to the schema in a future commit.
  // Until it exists there is no address to send to, and Resend rejects an
  // empty recipient list — so skip rather than issue a request that can only
  // fail.
  const recipients: string[] = [];

  if (recipients.length === 0) {
    console.warn(
      `[notifications] no email on record for creator ${creator.slug} — skipping tip notification`,
    );
    return;
  }

  const amount      = formatUsdc(event.amount, 2);
  const displayName = creator.displayName ?? creator.slug;
  const message     = event.message ? `"${event.message}"` : "No message left.";

  try {
    // Dynamic import so Resend is only loaded when the API key is set
    const { Resend } = await import("resend");
    const resend     = new Resend(config.resend.apiKey);

    // Resend reports API failures via the returned `error` rather than by
    // throwing, so the catch below never sees them — check it explicitly.
    const { error } = await resend.emails.send({
      from:    config.resend.from,
      to:      recipients,
      subject: `💸 You received $${amount} USDC on Novatip!`,
      html: `
        <h2>Hey ${displayName}!</h2>
        <p>
          Someone just tipped you <strong>$${amount} USDC</strong> on Novatip.
        </p>
        <p><em>${message}</em></p>
        <p>
          <a href="${config.appBaseUrl}/dashboard">View your dashboard →</a>
        </p>
      `,
    });

    if (error) {
      console.error("[notifications] Resend rejected the email:", error);
      return;
    }

    // Record notification in DB only once the send actually succeeded
    await db.notification.create({
      data: {
        creatorId: creator.id,
        type:      "TIP_RECEIVED",
        payload:   {
          from:      event.from,
          amount:    event.amount.toString(),
          message:   event.message,
          ledger:    event.ledger,
          timestamp: event.timestamp,
        },
        sentAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[notifications] failed to send email:", err);
  }
}
