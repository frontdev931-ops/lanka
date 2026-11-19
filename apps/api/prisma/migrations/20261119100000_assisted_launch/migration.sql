-- Assisted launch and the stored renewal price (2026-11-19)
ALTER TABLE "Clinic" ADD COLUMN "renewalPlan" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "renewalPriceUah" INTEGER;
ALTER TABLE "BillingPayment" ADD COLUMN "launchActivatedAt" TIMESTAMP(3);
ALTER TABLE "BillingPayment" ADD COLUMN "launchActivatedBy" TEXT;

-- Clinics that were already activated keep the price list of the time they paid at: Start 1 990, Pro 3 990 UAH a month.
-- Only standalone, non-demo clinics on Start or Pro that were activated (a paid launch, a paid period or an active billing state).
UPDATE "Clinic"
SET "renewalPlan" = "plan",
    "renewalPriceUah" = CASE "plan" WHEN 'PRO' THEN 3990 ELSE 1990 END
WHERE "isDemo" = false
  AND "networkId" IS NULL
  AND "plan" IN ('START', 'PRO')
  AND ("setupPaidAt" IS NOT NULL OR "paidUntil" IS NOT NULL OR "billingStatus" IN ('ACTIVE', 'PAST_DUE', 'LAPSED'));
