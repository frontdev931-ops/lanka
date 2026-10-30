-- AlterEnum
ALTER TYPE "Provider" ADD VALUE 'INSTAGRAM';

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_clinicId_channel_externalId_key" ON "ChatMessage"("clinicId", "channel", "externalId");
