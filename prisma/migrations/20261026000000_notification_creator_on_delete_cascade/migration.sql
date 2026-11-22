-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_creatorId_fkey";

-- AddForeignKey
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "Creator"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
