-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "birthDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "queuedAt" TIMESTAMP(3),
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_clinicId_createdAt_idx" ON "Campaign"("clinicId", "createdAt");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
