-- Per clinic: AI replies per chat per day (was a fixed 6) and the pause after a person's answer in minutes (was a fixed 30)
ALTER TABLE "Clinic" ADD COLUMN "aiRepliesPerChatDay" INTEGER NOT NULL DEFAULT 20, ADD COLUMN "aiPauseMinutes" INTEGER NOT NULL DEFAULT 30;
