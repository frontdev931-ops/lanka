-- The daily automatic Cliniccards load: the claimed clinic day, its attempts and the moment of the next attempt (one run per day across servers)
ALTER TABLE "Integration" ADD COLUMN "autoSyncDay" TEXT,
ADD COLUMN "autoSyncAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "autoSyncRetryAt" TIMESTAMP(3);
