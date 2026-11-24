/**
 * __tests__/notifications/email.test.ts
 *
 * Verifies tip notification emails dispatched via Resend:
 * - Includes both HTML and plain-text alternatives in the send payload.
 * - Confirms both parts carry the same amount, message, and dashboard link.
 * - Confirms the text part is not HTML-escaped.
 * - Confirms the creator-level emailEnabled switch gates the send.
 */

import { jest } from "@jest/globals";
import type { TipEvent } from "@novatip/sdk";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["RESEND_API_KEY"] = "re_test_key";
process.env["APP_BASE_URL"] = "https://app.novatip.xyz";
process.env["EMAIL_MAX_PER_CREATOR_PER_HOUR"] = "2";

type SendPayload = {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
};

type CreatorRecord = {
  id: string;
  slug: string;
  displayName?: string | null;
  email?: string | null;
  emailEnabled: boolean;
  emailVerifiedAt: Date | null;
};

type NotificationRecord = {
  id: string;
  creatorId: string;
  createdAt: Date;
  payload: unknown;
};

const mockSend =
  jest.fn<(payload: SendPayload) => Promise<{ error: null | Error }>>();

jest.unstable_mockModule("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockSend },
    },
  })),
}));

const mockDb = {
  creator: {
    findUnique: jest.fn<() => Promise<CreatorRecord | null>>(),
  },
  notification: {
    count: jest.fn<() => Promise<number>>(),
    create: jest.fn<() => Promise<{ id: string }>>(),
    update: jest.fn<() => Promise<unknown>>(),
    findMany: jest.fn<() => Promise<NotificationRecord[]>>(),
    updateMany: jest.fn<() => Promise<{ count: number }>>(),
  },
};

jest.unstable_mockModule("../../db.js", () => ({
  db: mockDb,
  disconnectDb: async (): Promise<void> => undefined,
}));

const { config } = await import("../../config.js");
const {
  sendPendingTipDigests,
  sendTipNotification,
  sendEmailVerificationEmail,
} = await import("../../modules/notifications/email.service.js");

describe("sendTipNotification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ error: null });
    mockDb.notification.count.mockResolvedValue(0);
    mockDb.notification.create.mockResolvedValue({ id: "notification_1" });
    mockDb.notification.update.mockResolvedValue({});
    mockDb.notification.findMany.mockResolvedValue([]);
    mockDb.notification.updateMany.mockResolvedValue({ count: 0 });
  });

  const tipEvent: TipEvent = {
    jarId: "@alice",
    from: "GUSER123",
    amount: 50000000n, // 5.00 USDC (7 decimals)
    message: "Thanks for the great work & tips <3!",
    ledger: 12345,
    timestamp: "2026-10-17T12:00:00Z",
    txHash: "0x1234567890abcdef",
  };

  it("sends both text and html parts carrying the same amount, message, and dashboard link", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: true,
      emailVerifiedAt: new Date(),
    });

    await sendTipNotification(tipEvent);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0]?.[0];
    if (!payload) throw new Error("mockSend payload is undefined");

    expect(payload.to).toEqual(["alice@example.com"]);
    expect(payload.subject).toContain("5.00 USDC");

    // Both text and html must be present
    expect(typeof payload.text).toBe("string");
    expect(typeof payload.html).toBe("string");

    // Both carry the same amount
    expect(payload.text).toContain("5.00 USDC");
    expect(payload.html).toContain("5.00 USDC");

    // Both carry the message
    expect(payload.text).toContain('"Thanks for the great work & tips <3!"');
    expect(payload.html).toContain(
      '"Thanks for the great work &amp; tips &lt;3!"',
    );

    // Both carry the dashboard link
    expect(payload.text).toContain("https://app.novatip.xyz/dashboard");
    expect(payload.html).toContain("https://app.novatip.xyz/dashboard");

    // Text part is plain text, not HTML formatted or escaped
    expect(payload.text).not.toContain("<strong>");
    expect(payload.text).not.toContain("<h2>");
    expect(payload.text).toContain("&");
    expect(payload.text).toContain("<3");
  });

  it("escapes tip messages and display names containing angle brackets and quotes in HTML", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "bob",
      displayName: 'Bob <Admin> "The Great"',
      email: "bob@example.com",
      emailEnabled: true,
      emailVerifiedAt: new Date(),
    });

    const xssTip: TipEvent = {
      ...tipEvent,
      message: `<script>alert("xss & 'pwned'")</script>`,
    };

    await sendTipNotification(xssTip);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0]?.[0];
    if (!payload) throw new Error("mockSend payload is undefined");

    // HTML part must be safely escaped
    expect(payload.html).toContain("Bob &lt;Admin&gt; &quot;The Great&quot;");
    expect(payload.html).toContain(
      "&lt;script&gt;alert(&quot;xss &amp; &#39;pwned&#39;&quot;)&lt;/script&gt;",
    );
    expect(payload.html).not.toContain('<script>alert("xss');

    // Text part remains raw unescaped text
    expect(payload.text).toContain('Bob <Admin> "The Great"');
    expect(payload.text).toContain("<script>alert(\"xss & 'pwned'\")</script>");
  });

  it("handles empty message gracefully in both text and html parts", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: true,
      emailVerifiedAt: new Date(),
    });

    const tipWithoutMessage: TipEvent = {
      ...tipEvent,
      message: "",
    };

    await sendTipNotification(tipWithoutMessage);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0]?.[0];
    if (!payload) throw new Error("mockSend payload is undefined");

    expect(payload.text).toContain("No message left.");
    expect(payload.html).toContain("No message left.");
  });

  it("skips notification when RESEND_API_KEY is not configured", async () => {
    const originalKey = config.resend.apiKey;
    try {
      (config.resend as { apiKey?: string | undefined }).apiKey = undefined;
      mockDb.creator.findUnique.mockResolvedValue({
        id: "creator_1",
        slug: "alice",
        email: "alice@example.com",
        emailEnabled: true,
        emailVerifiedAt: new Date(),
      });

      await sendTipNotification(tipEvent);

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockDb.notification.create).not.toHaveBeenCalled();
      expect(mockDb.notification.update).not.toHaveBeenCalled();
    } finally {
      (config.resend as { apiKey?: string | undefined }).apiKey = originalKey;
    }
  });

  it("skips notification when no creator exists for the jar", async () => {
    mockDb.creator.findUnique.mockResolvedValue(null);

    await sendTipNotification(tipEvent);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.update).not.toHaveBeenCalled();
  });

  it("skips notification when creator has no email on record", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: null,
      emailEnabled: true,
      emailVerifiedAt: null,
    });

    await sendTipNotification(tipEvent);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.update).not.toHaveBeenCalled();
  });

  it("skips the send when the creator has switched the channel off (emailEnabled false)", async () => {
    // Address on record and all — the switch alone decides.
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: false,
      emailVerifiedAt: new Date(),
    });

    it("does not email an unverified address", async () => {
      mockDb.creator.findUnique.mockResolvedValue({
        id: "creator_1",
        slug: "alice",
        displayName: "Alice",
        email: "unverified@example.com",
        emailEnabled: true,
        emailVerifiedAt: null,
      });

      await sendTipNotification(tipEvent);

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
      expect(mockDb.notification.update).not.toHaveBeenCalled();
    });

    await sendTipNotification(tipEvent);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.update).not.toHaveBeenCalled();
  });

  it("sends when the creator has the channel on (emailEnabled true)", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: true,
      emailVerifiedAt: new Date(),
    });

    await sendTipNotification(tipEvent);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.update).toHaveBeenCalledWith({
      where: { id: "notification_1" },
      data: { sentAt: expect.any(Date) },
    });
  });

  it("sends an individual tip email while below the per-hour cap", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: true,
      emailVerifiedAt: new Date(),
    });
    mockDb.notification.count.mockResolvedValue(1);

    await sendTipNotification(tipEvent);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.update).toHaveBeenCalledTimes(1);
  });

  it("records individual notification rows and marks successful sends", async () => {
  it("records every tip and sets sentAt only after a successful send", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: true,
      emailVerifiedAt: new Date(),
    });

    // Successful send marks the existing feed row as sent.
    mockSend.mockResolvedValueOnce({ error: null });
    await sendTipNotification(tipEvent);
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creatorId: "creator_1",
        type: "TIP_RECEIVED",
        payload: expect.objectContaining({
          from: tipEvent.from,
          amount: tipEvent.amount.toString(),
          ledger: tipEvent.ledger,
          txHash: tipEvent.txHash,
        }),
      }),
      select: { id: true },
    });
    expect(mockDb.notification.update).toHaveBeenCalledWith({
      where: { id: "notification_1" },
      data: { sentAt: expect.any(Date) },
    });
    expect(mockDb.notification.update).toHaveBeenCalledTimes(1);

    // A rejected individual send stays pending for the next digest.
    // A rejected email leaves a feed row with its default null sentAt.
    mockDb.notification.create.mockClear();
    mockDb.notification.update.mockClear();
    mockSend.mockResolvedValueOnce({ error: new Error("Resend rate limit") });
    await sendTipNotification(tipEvent);
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.update).not.toHaveBeenCalled();
  });

  it("queues a tip without sending an individual email after the cap", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: true,
      emailVerifiedAt: new Date(),
    });
    mockDb.notification.count.mockResolvedValue(2);

    await sendTipNotification(tipEvent);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
    expect(mockDb.notification.update).not.toHaveBeenCalled();
  });

  it("sends one digest for pending tips in a closed hour", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: true,
      emailVerifiedAt: new Date(),
    });
    mockDb.notification.findMany.mockResolvedValue([
      {
        id: "notice_1",
        creatorId: "creator_1",
        createdAt: new Date("2026-10-20T11:10:00.000Z"),
        payload: { amount: "50000000" },
      },
      {
        id: "notice_2",
        creatorId: "creator_1",
        createdAt: new Date("2026-10-20T11:55:00.000Z"),
        payload: { amount: "25000000" },
      },
    ]);

    const sent = await sendPendingTipDigests(
      new Date("2026-10-20T12:05:00.000Z"),
    );

    expect(sent).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0]?.[0];
    if (!payload) throw new Error("mockSend payload is undefined");
    expect(payload.subject).toContain("2 tips");
    expect(payload.text).toContain("7.50 USDC");
    expect(mockDb.notification.updateMany).toHaveBeenCalledWith({
      where: {
        creatorId: "creator_1",
        type: "TIP_RECEIVED",
        createdAt: {
          gte: new Date("2026-10-20T11:00:00.000Z"),
          lt: new Date("2026-10-20T12:00:00.000Z"),
        },
        sentAt: null,
      },
      data: { sentAt: new Date("2026-10-20T12:05:00.000Z") },
    });
  });

  it("includes txHash in the stored tip notification payload", async () => {
    mockDb.creator.findUnique.mockResolvedValue({
      id: "creator_1",
      slug: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      emailEnabled: false,
      emailVerifiedAt: null,
    });

    await sendTipNotification(tipEvent);

    expect(mockDb.notification.create).toHaveBeenCalledWith({
      data: {
        creatorId: "creator_1",
        type: "TIP_RECEIVED",
        payload: {
          from: tipEvent.from,
          amount: tipEvent.amount.toString(),
          message: tipEvent.message,
          ledger: tipEvent.ledger,
          timestamp: tipEvent.timestamp,
          txHash: tipEvent.txHash,
        },
      },
      select: { id: true },
    });
  });
});

describe("sendEmailVerificationEmail", () => {
  const email = "creator@example.com";
  const confirmationUrl =
    "https://app.novatip.xyz/verify?token=eyJh...&source=email<>&test=\"quoted\"";

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ error: null });
  });

  it("sends a verification email with plain text and escaped HTML", async () => {
    await sendEmailVerificationEmail(email, confirmationUrl);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload?.from).toBe(config.resend.from);
    expect(payload?.to).toEqual([email]);
    expect(payload?.subject).toBe("Confirm your Novatip notification email");

    // Text part contains unescaped confirmation URL
    expect(payload?.text).toContain(confirmationUrl);
    expect(payload?.text).toContain("This link expires in 24 hours.");

    // HTML part contains properly escaped confirmation URL in href
    expect(payload?.html).toContain(
      'href="https://app.novatip.xyz/verify?token=eyJh...&amp;source=email&lt;&gt;&amp;test=&quot;quoted&quot;"',
    );
    expect(payload?.html).toContain("Confirm email address");
  });

  it("throws 503 EMAIL_DELIVERY_UNAVAILABLE when resend.apiKey is not configured", async () => {
    const originalApiKey = config.resend.apiKey;
    try {
      (config.resend as { apiKey?: string }).apiKey = "";

      await expect(
        sendEmailVerificationEmail(email, confirmationUrl),
      ).rejects.toMatchObject({
        message: "Email delivery is not configured.",
        statusCode: 503,
        code: "EMAIL_DELIVERY_UNAVAILABLE",
      });

      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      (config.resend as { apiKey?: string }).apiKey = originalApiKey;
    }
  });

  it("throws 502 EMAIL_DELIVERY_FAILED when Resend returns an error", async () => {
    mockSend.mockResolvedValueOnce({
      error: new Error("Rate limit exceeded"),
    });

    await expect(
      sendEmailVerificationEmail(email, confirmationUrl),
    ).rejects.toMatchObject({
      message: "Could not send the email verification message.",
      statusCode: 502,
      code: "EMAIL_DELIVERY_FAILED",
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
