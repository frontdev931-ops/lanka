-- The agent's limited autonomous mode: an explicit per-clinic switch (off by default) and the one test service it may offer;
-- the last incoming message the autonomous turn has handled (so a new message is never lost and a handled one is not handled twice)
ALTER TABLE "Clinic" ADD COLUMN "aiAgentAuto" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "agentAutoServiceId" TEXT;
ALTER TABLE "ConversationState" ADD COLUMN "autoSeenAt" TIMESTAMP(3), ADD COLUMN "autoSeenId" TEXT;
