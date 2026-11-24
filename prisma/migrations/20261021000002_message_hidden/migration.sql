-- Add messageHidden column to Tip table
ALTER TABLE "Tip" ADD COLUMN "messageHidden" BOOLEAN NOT NULL DEFAULT false;
