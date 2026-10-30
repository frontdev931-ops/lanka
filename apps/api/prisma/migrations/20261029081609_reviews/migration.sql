-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "reviewUrl" TEXT;

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "doctorName" TEXT,
    "comment" TEXT,
    "awaitingUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_visitId_key" ON "Review"("visitId");

-- CreateIndex
CREATE INDEX "Review_clinicId_createdAt_idx" ON "Review"("clinicId", "createdAt");

-- CreateIndex
CREATE INDEX "Review_clinicId_doctorName_idx" ON "Review"("clinicId", "doctorName");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
