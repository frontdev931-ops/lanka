-- A master switch per signal (2026-11-23). Every existing rule stays monitored (all rules were measured and shown until now); the email,
-- push and Telegram preferences are not touched, so no notification channel is switched on by this migration.
ALTER TABLE "AlertRule" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
