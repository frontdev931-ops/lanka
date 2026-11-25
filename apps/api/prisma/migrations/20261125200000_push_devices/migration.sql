-- Push per device (2026-11-25): the language of the texts and when the person switched it on (older events are never delivered to it)
ALTER TABLE "PushSubscription" ADD COLUMN "lang" TEXT NOT NULL DEFAULT 'uk';
ALTER TABLE "PushSubscription" ADD COLUMN "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
