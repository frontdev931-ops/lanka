-- CreateTable
CREATE TABLE "AdAccountLink" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "timezoneName" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "connectedById" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "refreshClaimAt" TIMESTAMP(3),

    CONSTRAINT "AdAccountLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdConnectSession" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "accounts" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdConnectSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdInsightDay" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "spend" DECIMAL(14,2) NOT NULL,
    "impressions" INTEGER NOT NULL,
    "linkClicks" INTEGER,
    "leadForm" INTEGER,
    "messaging" INTEGER,
    "website" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdInsightDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdPeriodReach" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "since" TEXT NOT NULL,
    "until" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL DEFAULT '',
    "reach" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdPeriodReach_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdAccountLink_clinicId_key" ON "AdAccountLink"("clinicId");

-- CreateIndex
CREATE INDEX "AdConnectSession_clinicId_idx" ON "AdConnectSession"("clinicId");

-- CreateIndex
CREATE INDEX "AdInsightDay_clinicId_accountId_day_idx" ON "AdInsightDay"("clinicId", "accountId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AdInsightDay_clinicId_accountId_campaignId_day_key" ON "AdInsightDay"("clinicId", "accountId", "campaignId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AdPeriodReach_clinicId_accountId_since_until_campaignId_key" ON "AdPeriodReach"("clinicId", "accountId", "since", "until", "campaignId");

-- AddForeignKey
ALTER TABLE "AdAccountLink" ADD CONSTRAINT "AdAccountLink_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

