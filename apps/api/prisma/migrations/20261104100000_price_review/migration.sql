-- Positions that disappeared from the price list, the price the administrator chose to keep, a dismissed name match, and a note on an unapplied price list
ALTER TABLE "KbItem" ADD COLUMN "missingInSourceAt" TIMESTAMP(3), ADD COLUMN "externalPriceAcked" INTEGER, ADD COLUMN "matchDismissed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "priceListNote" TEXT;
