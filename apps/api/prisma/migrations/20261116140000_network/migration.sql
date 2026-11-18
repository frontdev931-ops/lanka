-- Networks of clinics. Nothing is grouped: every existing clinic stays standalone (networkId NULL).
CREATE TABLE "Network" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "billingStatus" TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "paidUntil" TIMESTAMP(3),
    "periodStartsAt" TIMESTAMP(3),
    "setupPaidAt" TIMESTAMP(3),
    "digest" TEXT NOT NULL DEFAULT 'WEEKLY',
    "lastDigestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Network_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "NetworkMember" (
    "id" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetworkMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NetworkMember_networkId_userId_key" ON "NetworkMember"("networkId", "userId");
ALTER TABLE "NetworkMember" ADD CONSTRAINT "NetworkMember_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NetworkMember" ADD CONSTRAINT "NetworkMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Clinic" ADD COLUMN "networkId" TEXT, ADD COLUMN "branchSetupQuoteUah" INTEGER, ADD COLUMN "branchSetupPaidAt" TIMESTAMP(3);
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingPayment" ADD COLUMN "networkId" TEXT;
