-- When the channel confirmed that it accepted the message of this approval (written right after the transport answered, before anything else is saved).
-- A draft left half-way is completed as sent only on this stored confirmation; without it the result stays unknown.
ALTER TABLE "AgentDraft" ADD COLUMN "transportConfirmedAt" TIMESTAMP(3);
