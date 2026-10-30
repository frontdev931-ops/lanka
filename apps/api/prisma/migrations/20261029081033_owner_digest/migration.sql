-- AlterTable
ALTER TABLE "ChannelLink" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'PATIENT';

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "digestFrequency" TEXT NOT NULL DEFAULT 'OFF',
ADD COLUMN     "digestHour" INTEGER NOT NULL DEFAULT 9,
ADD COLUMN     "digestWeekday" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "lastDigestAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DigestRecipient" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'uk',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DigestRecipient_clinicId_chatId_key" ON "DigestRecipient"("clinicId", "chatId");

-- AddForeignKey
ALTER TABLE "DigestRecipient" ADD CONSTRAINT "DigestRecipient_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
