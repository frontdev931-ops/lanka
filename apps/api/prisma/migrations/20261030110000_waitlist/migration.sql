CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorName" TEXT,
    "weekdays" JSONB NOT NULL DEFAULT '[]',
    "fromHour" INTEGER NOT NULL DEFAULT 9,
    "toHour" INTEGER NOT NULL DEFAULT 20,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WaitlistEntry_clinicId_status_idx" ON "WaitlistEntry"("clinicId", "status");
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SlotOffer" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "activeKey" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "doctorName" TEXT,
    "cabinetName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OFFERED',
    "outboundId" TEXT,
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotOffer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SlotOffer_clinicId_activeKey_key" ON "SlotOffer"("clinicId", "activeKey");
CREATE INDEX "SlotOffer_clinicId_status_idx" ON "SlotOffer"("clinicId", "status");
CREATE INDEX "SlotOffer_entryId_idx" ON "SlotOffer"("entryId");
ALTER TABLE "SlotOffer" ADD CONSTRAINT "SlotOffer_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlotOffer" ADD CONSTRAINT "SlotOffer_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "WaitlistEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
