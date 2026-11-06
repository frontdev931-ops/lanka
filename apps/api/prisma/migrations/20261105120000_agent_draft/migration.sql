-- CreateTable
CREATE TABLE "AgentDraft" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "basisMessageId" TEXT NOT NULL,
    "basisAt" TIMESTAMP(3) NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "basisOwner" TEXT NOT NULL DEFAULT 'BOT',
    "createdById" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "snapshot" JSONB NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "choice" TEXT,
    "messageId" TEXT,
    "requestId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentDraft_clinicId_channel_chatId_createdAt_idx" ON "AgentDraft"("clinicId", "channel", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentDraft_createdAt_idx" ON "AgentDraft"("createdAt");

-- AddForeignKey
ALTER TABLE "AgentDraft" ADD CONSTRAINT "AgentDraft_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

