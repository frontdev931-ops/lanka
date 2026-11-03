-- Working hours and the price list imported from Cliniccards, with their source and time
ALTER TABLE "Clinic" ADD COLUMN "workHoursSource" TEXT, ADD COLUMN "workHoursUpdatedAt" TIMESTAMP(3), ADD COLUMN "workHoursHolidays" JSONB NOT NULL DEFAULT '[]', ADD COLUMN "priceListSyncedAt" TIMESTAMP(3), ADD COLUMN "priceListCount" INTEGER;
ALTER TABLE "KbItem" ADD COLUMN "externalTitle" TEXT, ADD COLUMN "externalPrice" INTEGER;
-- Hours that were saved before the source was recorded were typed by the clinic
UPDATE "Clinic" SET "workHoursSource" = 'MANUAL', "workHoursUpdatedAt" = now() WHERE "workHours" IS NOT NULL AND "workHours"::text NOT IN ('{}', 'null', '');
