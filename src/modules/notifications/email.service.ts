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

  const amount      = formatUsdc(event.amount, 2);
  const displayName = creator.displayName ?? creator.slug;
  const message     = event.message ? `"${event.message}"` : "No message left.";

  try {
    // Dynamic import so Resend is only loaded when the API key is set
    const { Resend } = await import("@resend/node");
    const resend     = new Resend(config.resend.apiKey);

    await resend.emails.send({
      from:    config.resend.from,
      to:      [], // TODO: add creator email field to schema in a future commit
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

    // Record notification in DB
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
