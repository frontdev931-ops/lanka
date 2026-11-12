-- The staff alert about a used-up AI allowance: delivered marker and the last attempt (one alert per exhaustion episode)
ALTER TABLE "Clinic" ADD COLUMN "aiLimitAlertAt" TIMESTAMP(3),
ADD COLUMN "aiLimitAlertTryAt" TIMESTAMP(3);
