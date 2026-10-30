-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "balancePaid" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN     "extra" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "PlanItem" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2),
    "status" TEXT NOT NULL,
    "createdAtExt" TIMESTAMP(3) NOT NULL,
    "markedDoneAt" TIMESTAMP(3),
    "doneByDoctorId" TEXT,

    CONSTRAINT "PlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "externalId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "externalId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "issuerName" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "doctorName" TEXT,
    "cabinetId" TEXT NOT NULL,
    "cabinetName" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservedBlock" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "cabinetId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,

    CONSTRAINT "ReservedBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanItem_clinicId_patientId_idx" ON "PlanItem"("clinicId", "patientId");

-- CreateIndex
CREATE INDEX "PlanItem_clinicId_status_idx" ON "PlanItem"("clinicId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlanItem_clinicId_externalId_key" ON "PlanItem"("clinicId", "externalId");

-- CreateIndex
CREATE INDEX "Payment_clinicId_paidAt_idx" ON "Payment"("clinicId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_clinicId_externalId_key" ON "Payment"("clinicId", "externalId");

-- CreateIndex
CREATE INDEX "Invoice_clinicId_issuedAt_idx" ON "Invoice"("clinicId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_clinicId_externalId_key" ON "Invoice"("clinicId", "externalId");

-- CreateIndex
CREATE INDEX "Shift_clinicId_startsAt_idx" ON "Shift"("clinicId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_clinicId_externalId_key" ON "Shift"("clinicId", "externalId");

-- CreateIndex
CREATE INDEX "ReservedBlock_clinicId_startsAt_idx" ON "ReservedBlock"("clinicId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReservedBlock_clinicId_externalId_key" ON "ReservedBlock"("clinicId", "externalId");

-- AddForeignKey
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservedBlock" ADD CONSTRAINT "ReservedBlock_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
