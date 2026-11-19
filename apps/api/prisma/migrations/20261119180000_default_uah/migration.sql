-- Hryvnia by default (2026-11-19): LANKA serves Ukrainian clinics and no longer asks for the currency of Cliniccards amounts.
-- Only clinics that never stated a currency get UAH; a stated currency (UAH or another) is kept, and no stamp that is already there changes.
ALTER TABLE "Clinic" ALTER COLUMN "sourceCurrency" SET DEFAULT 'UAH';
ALTER TABLE "Clinic" ALTER COLUMN "planCurrency" SET DEFAULT 'UAH';

-- remember which clinics are defaulted now, so only their unconfirmed amounts are stamped
CREATE TEMP TABLE "_uah_finance" AS SELECT id FROM "Clinic" WHERE "sourceCurrency" IS NULL;
CREATE TEMP TABLE "_uah_plans" AS SELECT id FROM "Clinic" WHERE "planCurrency" IS NULL;

UPDATE "Clinic" SET "sourceCurrency" = 'UAH' WHERE id IN (SELECT id FROM "_uah_finance");
UPDATE "Clinic" SET "planCurrency" = 'UAH' WHERE id IN (SELECT id FROM "_uah_plans");

-- their amounts loaded without a stamp become hryvnia; amounts of clinics with a stated currency are not touched here
UPDATE "Payment" SET "currency" = 'UAH' WHERE "currency" IS NULL AND "clinicId" IN (SELECT id FROM "_uah_finance");
UPDATE "Invoice" SET "currency" = 'UAH' WHERE "currency" IS NULL AND "clinicId" IN (SELECT id FROM "_uah_finance");
UPDATE "Patient" SET "balanceCurrency" = 'UAH' WHERE "balanceCurrency" IS NULL AND "clinicId" IN (SELECT id FROM "_uah_finance");
UPDATE "TreatmentPlan" SET "currency" = 'UAH' WHERE "currency" IS NULL AND "clinicId" IN (SELECT id FROM "_uah_plans");

DROP TABLE "_uah_finance";
DROP TABLE "_uah_plans";
