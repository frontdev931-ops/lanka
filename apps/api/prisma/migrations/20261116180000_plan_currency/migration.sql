-- The currency of treatment-plan totals is stated separately from payments, invoices and balances. Nothing is filled in.
ALTER TABLE "Clinic" ADD COLUMN "planCurrency" TEXT, ADD COLUMN "planCurrencyStatedAt" TIMESTAMP(3), ADD COLUMN "planCurrencyStatedById" TEXT;
