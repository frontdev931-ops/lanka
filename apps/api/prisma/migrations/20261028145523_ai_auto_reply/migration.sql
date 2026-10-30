-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "byAi" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "aiAutoReply" BOOLEAN NOT NULL DEFAULT false;
