-- CreateEnum
CREATE TYPE "ContactConsent" AS ENUM ('UNKNOWN', 'GIVEN', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "automationPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consent" "ContactConsent" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "consentNote" TEXT,
ADD COLUMN     "consentUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "extra" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "phoneNorm" TEXT;

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactLog" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "userId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'OTHER',
    "outcome" "TaskResult",
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "taskId" TEXT,
    "importBatchId" TEXT,
    "contactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT,
    "filename" TEXT NOT NULL,
    "type" TEXT,
    "columns" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_clinicId_idx" ON "Invitation"("clinicId");

-- CreateIndex
CREATE INDEX "ContactLog_clinicId_patientId_contactedAt_idx" ON "ContactLog"("clinicId", "patientId", "contactedAt");

-- CreateIndex
CREATE INDEX "ImportBatch_clinicId_createdAt_idx" ON "ImportBatch"("clinicId", "createdAt");

-- CreateIndex
CREATE INDEX "Patient_clinicId_phoneNorm_idx" ON "Patient"("clinicId", "phoneNorm");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactLog" ADD CONSTRAINT "ContactLog_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactLog" ADD CONSTRAINT "ContactLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactLog" ADD CONSTRAINT "ContactLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
