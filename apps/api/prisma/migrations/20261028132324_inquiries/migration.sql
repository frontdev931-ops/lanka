-- CreateTable
CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL,
    "phone" TEXT,
    "phoneNorm" TEXT,
    "name" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "patientId" TEXT,
    "returning" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Inquiry_clinicId_occurredAt_idx" ON "Inquiry"("clinicId", "occurredAt");

-- CreateIndex
CREATE INDEX "Inquiry_clinicId_phoneNorm_idx" ON "Inquiry"("clinicId", "phoneNorm");

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
