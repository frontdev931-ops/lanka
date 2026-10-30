ALTER TABLE "Clinic" ADD COLUMN "leadKey" TEXT,
ADD COLUMN "leadEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "leadOrigins" JSONB NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX "Clinic_leadKey_key" ON "Clinic"("leadKey");

ALTER TABLE "Inquiry" ADD COLUMN "utmSource" TEXT,
ADD COLUMN "utmMedium" TEXT,
ADD COLUMN "utmCampaign" TEXT,
ADD COLUMN "landing" TEXT,
ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "Inquiry_clinicId_externalId_key" ON "Inquiry"("clinicId", "externalId");
