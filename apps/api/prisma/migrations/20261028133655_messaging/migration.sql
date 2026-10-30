-- AlterEnum
ALTER TYPE "Provider" ADD VALUE 'TELEGRAM';

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "autoSendService" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PatientChannel" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "username" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "optedOutAt" TIMESTAMP(3),

    CONSTRAINT "PatientChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelLink" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "params" JSONB NOT NULL DEFAULT '{}',
    "templates" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "visitId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientChannel_clinicId_channel_externalId_idx" ON "PatientChannel"("clinicId", "channel", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientChannel_patientId_channel_key" ON "PatientChannel"("patientId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLink_tokenHash_key" ON "ChannelLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRule_clinicId_key_key" ON "AutomationRule"("clinicId", "key");

-- CreateIndex
CREATE INDEX "OutboundMessage_clinicId_status_scheduledFor_idx" ON "OutboundMessage"("clinicId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "OutboundMessage_patientId_createdAt_idx" ON "OutboundMessage"("patientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_clinicId_dedupeKey_key" ON "OutboundMessage"("clinicId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "PatientChannel" ADD CONSTRAINT "PatientChannel_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientChannel" ADD CONSTRAINT "PatientChannel_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelLink" ADD CONSTRAINT "ChannelLink_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
