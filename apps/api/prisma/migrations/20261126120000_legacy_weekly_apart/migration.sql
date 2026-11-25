-- The old rolling 7-day weekly digest gets its own schedule, apart from the daily digest (2026-11-25). Existing values are carried over:
-- a clinic on WEEKLY keeps it (same weekday, hour and last sending) as legacyWeekly*, and its digest frequency becomes OFF (the daily digest was
-- not on); its people and chats that got it keep getting it (legacyWeekly), and their "digest" flag, which meant that weekly one, is not turned
-- into a daily subscription.
ALTER TABLE "Clinic" ADD COLUMN "legacyWeeklyOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "legacyWeeklyWeekday" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Clinic" ADD COLUMN "legacyWeeklyHour" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "Clinic" ADD COLUMN "lastLegacyWeeklyAt" TIMESTAMP(3);
ALTER TABLE "LeaderTelegram" ADD COLUMN "legacyWeekly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DigestRecipient" ADD COLUMN "legacyWeekly" BOOLEAN NOT NULL DEFAULT false;

UPDATE "LeaderTelegram" AS lt SET "legacyWeekly" = (lt."legacyWeeklyMovedAt" IS NULL), "digest" = false
  FROM "Clinic" AS c WHERE c."id" = lt."clinicId" AND c."digestFrequency" = 'WEEKLY' AND lt."digest" = true;
UPDATE "DigestRecipient" AS r SET "legacyWeekly" = true
  FROM "Clinic" AS c WHERE c."id" = r."clinicId" AND c."digestFrequency" = 'WEEKLY';
UPDATE "Clinic" SET "legacyWeeklyOn" = true, "legacyWeeklyWeekday" = "digestWeekday", "legacyWeeklyHour" = "digestHour", "lastLegacyWeeklyAt" = "lastDigestAt", "digestFrequency" = 'OFF'
  WHERE "digestFrequency" = 'WEEKLY';
