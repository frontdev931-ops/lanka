-- Follow-ups to agent dialogues that did not reach a booking (2026-11-23). Off for every clinic until its owner or manager switches them on.
ALTER TABLE "Clinic" ADD COLUMN "followUpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "followUpDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "followUpTexts" JSONB;

CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'uk',
    "text" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "basisMessageId" TEXT NOT NULL,
    "approvedById" TEXT,
    "sentAt" TIMESTAMP(3),
    "messageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FollowUp_clinicId_channel_chatId_basisMessageId_step_key" ON "FollowUp"("clinicId", "channel", "chatId", "basisMessageId", "step");
CREATE INDEX "FollowUp_clinicId_status_dueAt_idx" ON "FollowUp"("clinicId", "status", "dueAt");
CREATE INDEX "FollowUp_status_dueAt_idx" ON "FollowUp"("status", "dueAt");
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
