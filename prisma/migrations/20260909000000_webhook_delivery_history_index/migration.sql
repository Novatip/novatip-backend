-- DropIndex
-- Superseded by the composite below. A webhookId-leading composite index
-- answers every lookup the single-column index did, including the FK check
-- behind WebhookDelivery_webhookId_fkey (ON DELETE RESTRICT), so keeping both
-- buys nothing and costs a second write per delivery row on what the retention
-- notes already call the fastest-growing table in the database.
DROP INDEX "WebhookDelivery_webhookId_idx";

-- CreateIndex
-- Serves the delivery-history endpoint:
--   WHERE "webhookId" = ? ORDER BY "attemptedAt" DESC LIMIT n
-- With only "webhookId" indexed, Postgres reads every delivery row for that
-- webhook and sorts the lot to hand back twenty. Adding "attemptedAt" to the
-- index supplies the ordering, so the plan becomes a backward index scan that
-- stops after the page.
CREATE INDEX "WebhookDelivery_webhookId_attemptedAt_idx" ON "WebhookDelivery"("webhookId", "attemptedAt");
