-- Staff can give a dialog back to the bot before the pause after a person's answer ends
CREATE TABLE "ChatBotResume" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "resumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatBotResume_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChatBotResume_clinicId_channel_chatId_key" ON "ChatBotResume"("clinicId", "channel", "chatId");
ALTER TABLE "ChatBotResume" ADD CONSTRAINT "ChatBotResume_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
