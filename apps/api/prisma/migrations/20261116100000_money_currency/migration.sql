-- The currency of amounts loaded from Cliniccards: stated by the clinic's owner, stamped on every loaded amount. Nothing is filled in: every
-- existing amount stays "currency not confirmed" until the owner states it.
ALTER TABLE "Clinic" ADD COLUMN "sourceCurrency" TEXT, ADD COLUMN "sourceCurrencyStatedAt" TIMESTAMP(3), ADD COLUMN "sourceCurrencyStatedById" TEXT;
ALTER TABLE "Payment" ADD COLUMN "currency" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "currency" TEXT;
ALTER TABLE "TreatmentPlan" ADD COLUMN "currency" TEXT;
ALTER TABLE "Patient" ADD COLUMN "balanceCurrency" TEXT;
