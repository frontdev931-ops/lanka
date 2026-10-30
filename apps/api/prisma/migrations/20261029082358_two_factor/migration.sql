-- AlterTable
ALTER TABLE "User" ADD COLUMN     "recoveryHashes" JSONB,
ADD COLUMN     "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN     "totpLastStep" INTEGER,
ADD COLUMN     "totpSecretEnc" TEXT;
