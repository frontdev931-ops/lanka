-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "patientId" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reminder_clinicId_dueDate_idx" ON "Reminder"("clinicId", "dueDate");

-- CreateIndex
CREATE INDEX "Reminder_patientId_idx" ON "Reminder"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_clinicId_externalId_key" ON "Reminder"("clinicId", "externalId");

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
