-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "limitOverrides" JSONB,
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'TRIAL',
ADD COLUMN     "require2fa" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);
