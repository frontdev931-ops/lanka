ALTER TABLE "BillingPayment"
  ADD COLUMN "oneTimeProBuyerId" TEXT,
  ADD COLUMN "oneTimeProIncludesSetup" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "BillingPayment_one_time_pro_check" CHECK (
    ("oneTimeProBuyerId" IS NULL AND NOT "oneTimeProIncludesSetup")
    OR (
      "oneTimeProBuyerId" IS NOT NULL AND "kind" = 'SUBSCRIPTION'
      AND "plan" IS NOT DISTINCT FROM 'PRO' AND "networkId" IS NULL
      AND "amountMinor" = 100 AND "currency" = 980 AND "setupMinor" = 0
    )
  );
