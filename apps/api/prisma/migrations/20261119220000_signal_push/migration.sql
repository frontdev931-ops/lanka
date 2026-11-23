-- Push separated from email for signals (2026-11-19). "enabled" stays the email to the owner; "push" is the new switch for Push notifications.
-- Existing rules keep what they had: push on wherever "enabled" (email and push together until now) was on.
ALTER TABLE "AlertRule" ADD COLUMN "push" BOOLEAN NOT NULL DEFAULT false;
UPDATE "AlertRule" SET "push" = true WHERE "enabled" = true;
