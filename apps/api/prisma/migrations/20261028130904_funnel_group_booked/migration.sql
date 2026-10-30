-- AlterTable
ALTER TABLE "PlanItem" ADD COLUMN     "groupName" TEXT;

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "bookedAt" TIMESTAMP(3);
