-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskResult" AS ENUM ('BOOKED', 'CALL_LATER', 'NO_ANSWER', 'DECLINED');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "result" "TaskResult",
    "assigneeId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_clinicId_status_dueDate_idx" ON "Task"("clinicId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "Task_clinicId_patientId_idx" ON "Task"("clinicId", "patientId");

-- CreateIndex
CREATE INDEX "Patient_clinicId_fullName_idx" ON "Patient"("clinicId", "fullName");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
