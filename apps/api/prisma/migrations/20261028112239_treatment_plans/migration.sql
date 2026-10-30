-- CreateTable
CREATE TABLE "TreatmentPlan" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "totalDone" DECIMAL(14,2) NOT NULL,
    "createdAtExt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreatmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TreatmentPlan_clinicId_createdAtExt_idx" ON "TreatmentPlan"("clinicId", "createdAtExt");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentPlan_clinicId_externalId_key" ON "TreatmentPlan"("clinicId", "externalId");

-- AddForeignKey
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
