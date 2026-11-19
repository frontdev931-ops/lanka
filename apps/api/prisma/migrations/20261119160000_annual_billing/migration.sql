-- Annual prepaid subscriptions (2026-11-19). Existing orders keep NULL = monthly.
ALTER TABLE "BillingPayment" ADD COLUMN "months" INTEGER;
ALTER TABLE "BillingPayment" ADD COLUMN "monthlyMinor" INTEGER;
