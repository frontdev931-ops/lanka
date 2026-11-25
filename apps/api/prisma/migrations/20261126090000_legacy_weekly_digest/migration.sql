-- One person's explicit move from the old rolling 7-day weekly digest to the weekly report (2026-11-25). Nobody is moved by the migration.
ALTER TABLE "LeaderTelegram" ADD COLUMN "legacyWeeklyMovedAt" TIMESTAMP(3);
