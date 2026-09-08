-- AlterTable
-- Optional contact address for tip notifications. Nullable by design: a
-- creator who only wants webhooks should not have to supply one, and
-- sendTipNotification skips quietly when it is absent.
ALTER TABLE "Creator" ADD COLUMN "email" TEXT;
