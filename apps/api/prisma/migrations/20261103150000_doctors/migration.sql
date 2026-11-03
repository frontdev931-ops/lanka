-- The doctor for a first booking, the doctors of the clinic with what LANKA knows about them, the online-booking schedule kept in LANKA,
-- and the doctor of a request with the reason he was chosen
ALTER TABLE "Clinic" ADD COLUMN "primaryDoctorId" TEXT, ADD COLUMN "primaryDoctorName" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN "doctorId" TEXT, ADD COLUMN "doctorReason" TEXT, ADD COLUMN "doctorState" TEXT, ADD COLUMN "pendingDoctorId" TEXT, ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Doctor" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "serviceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "acceptsUrgent" BOOLEAN NOT NULL DEFAULT false,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Doctor_clinicId_externalId_key" ON "Doctor"("clinicId", "externalId");
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DoctorAvailability" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "weekday" INTEGER,
    "date" TEXT,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "fromHm" TEXT,
    "toHm" TEXT,
    "cabinetId" TEXT,
    CONSTRAINT "DoctorAvailability_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DoctorAvailability_clinicId_doctorId_idx" ON "DoctorAvailability"("clinicId", "doctorId");
ALTER TABLE "DoctorAvailability" ADD CONSTRAINT "DoctorAvailability_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
