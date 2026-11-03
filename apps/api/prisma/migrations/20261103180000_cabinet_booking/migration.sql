-- Booking by cabinets through one shared Cliniccards account (an alternative to booking by doctors)
ALTER TABLE "Clinic" ADD COLUMN "scheduleMode" TEXT NOT NULL DEFAULT 'DOCTORS', ADD COLUMN "sharedDoctorId" TEXT, ADD COLUMN "sharedDoctorName" TEXT, ADD COLUMN "workHoursExceptions" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Cabinet" ADD COLUMN "onlineBooking" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "acceptsUrgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "KbItem" ADD COLUMN "onlineBooking" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "cabinetIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BookingRequest" ADD COLUMN "scheduleMode" TEXT, ADD COLUMN "cabinetId" TEXT, ADD COLUMN "wishedDoctor" TEXT;
