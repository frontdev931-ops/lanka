-- Signals: the rule's state apart from notification events (2026-11-25). No backfill on purpose: every existing rule starts with
-- evalState NULL, so its first check after the deploy only records the baseline and sends nothing accumulated.
ALTER TABLE "AlertRule" ADD COLUMN "evalState" TEXT;
ALTER TABLE "AlertRule" ADD COLUMN "evalValue" DOUBLE PRECISION;
ALTER TABLE "AlertRule" ADD COLUMN "evalAt" TIMESTAMP(3);

CREATE TABLE "SignalEvent" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "prevValue" DOUBLE PRECISION,
    "prevAt" TIMESTAMP(3),
    "facts" JSONB NOT NULL,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignalEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SignalDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignalDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SignalEvent_clinicId_kind_createdAt_idx" ON "SignalEvent"("clinicId", "kind", "createdAt");
CREATE UNIQUE INDEX "SignalDelivery_eventId_channel_target_key" ON "SignalDelivery"("eventId", "channel", "target");
CREATE INDEX "SignalDelivery_clinicId_status_idx" ON "SignalDelivery"("clinicId", "status");

ALTER TABLE "SignalEvent" ADD CONSTRAINT "SignalEvent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SignalDelivery" ADD CONSTRAINT "SignalDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SignalEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
