-- DropIndex
-- Every analytics query filters Tip by "creatorId" first (getTotals,
-- getTimeSeries, getTopSupporters, getRecentTips, the CSV export, and the
-- public feed), so the creatorId-leading composites below already serve a
-- plain "creatorId" lookup. Nothing queries by "creatorId" alone without one
-- of those, so the single-column index bought nothing but a third write per
-- tip insert. Same reasoning as the Creator_walletAddress_idx /
-- Creator_slug_idx drop in 20261017000000_drop_creator_redundant_indexes.
DROP INDEX "Tip_creatorId_idx";

-- DropIndex
-- "fromAddress" is only ever read via getTopSupporters' GROUP BY, which is
-- already scoped to a creator and served by Tip_creatorId_fromAddress_idx.
-- Nothing filters or sorts by "fromAddress" on its own.
DROP INDEX "Tip_fromAddress_idx";

-- DropIndex
-- Nothing in the codebase filters or sorts by "ledger" on its own; the
-- indexer looks tips up by the unique "txHash", and every ledger-scoped read
-- goes through "ledgerAt" instead.
DROP INDEX "Tip_ledger_idx";

-- DropIndex
-- Nothing filters or sorts by "ledgerAt" without a "creatorId" filter ahead
-- of it, which Tip_creatorId_ledgerAt_idx already serves (getTimeSeries,
-- getRecentTips, the CSV export, and the public feed all order by
-- "ledgerAt" DESC within a single creator).
DROP INDEX "Tip_ledgerAt_idx";
