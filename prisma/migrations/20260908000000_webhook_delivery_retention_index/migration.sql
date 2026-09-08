-- CreateIndex
-- Supports the delivery retention prune, which deletes in batches matching
-- `success = ? AND "attemptedAt" < ?`. Successes and failures are pruned on
-- separate schedules, so "success" leads and "attemptedAt" gives the range
-- within each half. Without this the prune sequential-scans a table that is
-- only ever growing.
CREATE INDEX "WebhookDelivery_success_attemptedAt_idx" ON "WebhookDelivery"("success", "attemptedAt");
