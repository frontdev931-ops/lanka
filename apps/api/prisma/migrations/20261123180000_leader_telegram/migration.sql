-- AlterTable
ALTER TABLE "DigestRecipient" ADD COLUMN     "migratedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LeaderTelegram" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "tgName" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'uk',
    "digest" BOOLEAN NOT NULL DEFAULT false,
    "signals" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockedAt" TIMESTAMP(3),

    CONSTRAINT "LeaderTelegram_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaderTelegram_clinicId_userId_key" ON "LeaderTelegram"("clinicId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderTelegram_clinicId_chatId_key" ON "LeaderTelegram"("clinicId", "chatId");

-- AddForeignKey
ALTER TABLE "LeaderTelegram" ADD CONSTRAINT "LeaderTelegram_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderTelegram" ADD CONSTRAINT "LeaderTelegram_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

