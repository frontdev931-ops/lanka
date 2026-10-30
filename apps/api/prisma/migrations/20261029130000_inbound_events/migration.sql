-- CreateTable
CREATE TABLE "InboundEvent" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_channel_externalId_key" ON "InboundEvent"("channel", "externalId");

-- CreateIndex
CREATE INDEX "InboundEvent_status_nextAttemptAt_idx" ON "InboundEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InboundEvent_clinicId_status_idx" ON "InboundEvent"("clinicId", "status");

-- AddForeignKey
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
