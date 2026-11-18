ALTER TABLE "BillingPayment"
  ADD COLUMN "periodTo" TIMESTAMP(3),
  ADD COLUMN "currency" INTEGER NOT NULL DEFAULT 980,
  ADD COLUMN "branchIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "monoInvoiceId" TEXT,
  ADD COLUMN "monoPageUrl" TEXT,
  ADD COLUMN "monoExpiresAt" TIMESTAMP(3),
  ADD COLUMN "monoModifiedAt" TIMESTAMP(3),
  ADD COLUMN "monoCheckedAt" TIMESTAMP(3),
  ADD COLUMN "refundedMinor" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "BillingPayment_monoInvoiceId_key" ON "BillingPayment"("monoInvoiceId");
CREATE INDEX "BillingPayment_networkId_kind_status_idx" ON "BillingPayment"("networkId", "kind", "status");
CREATE INDEX "BillingPayment_status_monoCheckedAt_idx" ON "BillingPayment"("status", "monoCheckedAt");
