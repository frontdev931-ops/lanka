-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "channel" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "contactName" TEXT,
    "direction" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorUserId" TEXT,
    "readAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatMessage_clinicId_channel_chatId_createdAt_idx" ON "ChatMessage"("clinicId", "channel", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_clinicId_createdAt_idx" ON "ChatMessage"("clinicId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_patientId_createdAt_idx" ON "ChatMessage"("patientId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
