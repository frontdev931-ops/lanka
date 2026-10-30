-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stage" TEXT;
