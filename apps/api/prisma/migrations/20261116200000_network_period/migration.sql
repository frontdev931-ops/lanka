-- The network period a payment buys: a period is granted once.
ALTER TABLE "BillingPayment" ADD COLUMN "periodFrom" TIMESTAMP(3);
