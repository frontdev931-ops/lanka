-- Requests to discuss connecting another clinic (2026-11-19)
CREATE TABLE "AdditionalClinicRequest" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),
    "handledBy" TEXT,
    CONSTRAINT "AdditionalClinicRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdditionalClinicRequest_clinicId_createdAt_idx" ON "AdditionalClinicRequest"("clinicId", "createdAt");
CREATE INDEX "AdditionalClinicRequest_handledAt_createdAt_idx" ON "AdditionalClinicRequest"("handledAt", "createdAt");
-- One open request per clinic, also under concurrent clicks
CREATE UNIQUE INDEX "AdditionalClinicRequest_open_clinic_key" ON "AdditionalClinicRequest"("clinicId") WHERE "handledAt" IS NULL;
ALTER TABLE "AdditionalClinicRequest" ADD CONSTRAINT "AdditionalClinicRequest_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
