-- Worsening notices of a lasting signal deviation (2026-11-25). No base is filled in: a rule already deviating gets its base at its first
-- successful measurement after the deploy, without any message (nothing accumulated is sent).
ALTER TABLE "AlertRule" ADD COLUMN "baseValue" DOUBLE PRECISION;
ALTER TABLE "AlertRule" ADD COLUMN "baseAt" TIMESTAMP(3);
ALTER TABLE "AlertRule" ADD COLUMN "baseFacts" JSONB;
ALTER TABLE "AlertRule" ADD COLUMN "lastWorseAt" TIMESTAMP(3);
ALTER TABLE "AlertRule" ADD COLUMN "syncEscalatedAt" TIMESTAMP(3);
ALTER TABLE "SignalEvent" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'FIRED';
