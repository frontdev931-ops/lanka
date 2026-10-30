-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "undoData" JSONB,
ADD COLUMN     "undoneAt" TIMESTAMP(3);
