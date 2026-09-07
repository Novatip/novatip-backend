-- CreateIndex
-- Supports getTopSupporters' GROUP BY "fromAddress" scoped to a creator.
CREATE INDEX "Tip_creatorId_fromAddress_idx" ON "Tip"("creatorId", "fromAddress");

-- CreateIndex
-- Supports getTimeSeries' GROUP BY date_trunc("ledgerAt") scoped to a creator.
CREATE INDEX "Tip_creatorId_ledgerAt_idx" ON "Tip"("creatorId", "ledgerAt");
