-- AlterTable
ALTER TABLE "ContactRequest" ADD COLUMN     "clinicId" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "installedAt" TIMESTAMP(3),
ADD COLUMN     "websiteOrigin" TEXT,
ALTER COLUMN "phone" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ContactRequest_clinicId_createdAt_idx" ON "ContactRequest"("clinicId", "createdAt");

-- A clinic can have only one open website connection request, including concurrent submissions.
CREATE UNIQUE INDEX "ContactRequest_open_website_clinic_key" ON "ContactRequest"("clinicId") WHERE "clinicId" IS NOT NULL AND "handledAt" IS NULL;

-- AddForeignKey
ALTER TABLE "ContactRequest" ADD CONSTRAINT "ContactRequest_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
