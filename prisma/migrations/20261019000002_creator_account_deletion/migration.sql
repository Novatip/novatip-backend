-- Keep immutable indexed tip history after its creator profile is removed.
ALTER TABLE "Tip" ALTER COLUMN "creatorId" DROP NOT NULL;

ALTER TABLE "Tip" DROP CONSTRAINT "Tip_creatorId_fkey";
ALTER TABLE "Tip"
  ADD CONSTRAINT "Tip_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "Creator"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
