-- The AI limit alert: the Telegram request ended without an answer, so the delivery is unknown (not delivered, not repeated in this episode)
ALTER TABLE "Clinic" ADD COLUMN "aiLimitAlertUnknownAt" TIMESTAMP(3);
