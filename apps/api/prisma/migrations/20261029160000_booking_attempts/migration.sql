ALTER TABLE "Clinic" ADD COLUMN "bookingWriteEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "BookingAttempt" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "patientId" TEXT,
    "requestId" TEXT,
    "startsAt" TIMESTAMP(3),
    "externalVisitId" TEXT,
    "externalPatientId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingAttempt_clinicId_key_key" ON "BookingAttempt"("clinicId", "key");
CREATE INDEX "BookingAttempt_clinicId_createdAt_idx" ON "BookingAttempt"("clinicId", "createdAt");
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
