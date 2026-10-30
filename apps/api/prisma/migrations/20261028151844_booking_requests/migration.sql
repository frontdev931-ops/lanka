-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "channel" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "contactName" TEXT,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingRequest_clinicId_status_createdAt_idx" ON "BookingRequest"("clinicId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_clinicId_channel_chatId_status_idx" ON "BookingRequest"("clinicId", "channel", "chatId", "status");

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
