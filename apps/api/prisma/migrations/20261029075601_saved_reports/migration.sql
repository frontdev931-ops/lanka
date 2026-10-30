-- CreateTable
CREATE TABLE "SavedReport" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedReport_clinicId_createdAt_idx" ON "SavedReport"("clinicId", "createdAt");

-- AddForeignKey
ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
