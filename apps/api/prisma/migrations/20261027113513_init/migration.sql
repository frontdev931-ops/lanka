-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'ADMIN', 'DOCTOR', 'ANALYST');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('CLINICCARDS');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'OK', 'FAILED');

-- CreateTable
CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "apiKeyEnc" TEXT,
    "lastSyncAt" TIMESTAMP(3),

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "source" TEXT,
    "preferredContact" TEXT,
    "lastVisitAt" TIMESTAMP(3),
    "balanceIssued" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "doctorId" TEXT,
    "doctorName" TEXT,
    "cabinetId" TEXT,
    "serviceName" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "amount" DECIMAL(12,2),

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "patients" INTEGER NOT NULL DEFAULT 0,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_clinicId_key" ON "Membership"("userId", "clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_clinicId_provider_key" ON "Integration"("clinicId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_clinicId_externalId_key" ON "Patient"("clinicId", "externalId");

-- CreateIndex
CREATE INDEX "Visit_clinicId_startsAt_idx" ON "Visit"("clinicId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_clinicId_externalId_key" ON "Visit"("clinicId", "externalId");

-- CreateIndex
CREATE INDEX "AuditLog_clinicId_createdAt_idx" ON "AuditLog"("clinicId", "createdAt");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
