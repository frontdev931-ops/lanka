-- The scope of the agent's autonomous mode: DIALOGS (the older restricted test mode, only the dialogs of the server list) or CLINIC (the clinic's owner
-- switched it on for the whole clinic). Existing clinics stay DIALOGS: nothing is broadened.
ALTER TABLE "Clinic" ADD COLUMN "agentAutoScope" TEXT NOT NULL DEFAULT 'DIALOGS';
-- A running load proves it is alive: with several API servers a start of one must not mark another one's load as interrupted
ALTER TABLE "SyncRun" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
