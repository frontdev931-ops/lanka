-- Clinics that exist today keep working: they are active and move from TRIAL to START
ALTER TABLE "Clinic" ALTER COLUMN "plan" SET DEFAULT 'START';
UPDATE "Clinic" SET "plan" = 'START' WHERE "plan" = 'TRIAL';
ALTER TABLE "Clinic" ALTER COLUMN "aiMonthlyLimit" SET DEFAULT 500;

ALTER TABLE "Clinic" ADD COLUMN "billingStatus" TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
ADD COLUMN "paidUntil" TIMESTAMP(3),
ADD COLUMN "periodStartsAt" TIMESTAMP(3),
ADD COLUMN "setupPaidAt" TIMESTAMP(3),
ADD COLUMN "aiPurchased" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "aiPackCapPerMonth" INTEGER NOT NULL DEFAULT 5;
UPDATE "Clinic" SET "billingStatus" = 'ACTIVE';

ALTER TABLE "AiUsage" ADD COLUMN "billable" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "BillingPayment" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "plan" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "setupMinor" INTEGER NOT NULL DEFAULT 0,
    "packReplies" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPayment_orderId_key" ON "BillingPayment"("orderId");
CREATE INDEX "BillingPayment_clinicId_createdAt_idx" ON "BillingPayment"("clinicId", "createdAt");
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
