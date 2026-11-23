-- Per-signal Telegram switch (2026-11-19). Until now "enabled" meant the staff Telegram chat, the phone (push) and the owner's email together;
-- the Telegram part is now its own switch. Existing rules keep what they had: Telegram on where the rule was on. Email/push stay on "enabled".
ALTER TABLE "AlertRule" ADD COLUMN "telegram" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AlertRule" ADD COLUMN "telegramSentAt" TIMESTAMP(3);
ALTER TABLE "AlertRule" ADD COLUMN "telegramClaimAt" TIMESTAMP(3);
UPDATE "AlertRule" SET "telegram" = true, "telegramSentAt" = "lastFiredAt" WHERE "enabled" = true;
