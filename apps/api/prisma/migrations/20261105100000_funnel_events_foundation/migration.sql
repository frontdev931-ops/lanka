-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "aiAgentMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "funnelEventsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ConversationState" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "owner" TEXT NOT NULL DEFAULT 'BOT',
    "salesStage" TEXT NOT NULL DEFAULT 'NEW',
    "serviceId" TEXT,
    "clarifyCount" INTEGER NOT NULL DEFAULT 0,
    "doubtsHandled" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastDecisionMessageId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunnelEvent" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refKey" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT,
    "leadStatus" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunnelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationState_clinicId_channel_chatId_key" ON "ConversationState"("clinicId", "channel", "chatId");

-- CreateIndex
CREATE INDEX "FunnelEvent_clinicId_occurredAt_idx" ON "FunnelEvent"("clinicId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelEvent_clinicId_conversationId_kind_refKey_key" ON "FunnelEvent"("clinicId", "conversationId", "kind", "refKey");

-- AddForeignKey
ALTER TABLE "ConversationState" ADD CONSTRAINT "ConversationState_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunnelEvent" ADD CONSTRAINT "FunnelEvent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunnelEvent" ADD CONSTRAINT "FunnelEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ConversationState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

