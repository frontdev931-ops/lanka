-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedById" TEXT,
ADD COLUMN     "termsVersion" TEXT;
