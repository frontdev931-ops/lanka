CREATE TABLE "ScheduledReport" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "savedReportId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "hour" INTEGER NOT NULL DEFAULT 8,
    "weekday" INTEGER NOT NULL DEFAULT 1,
    "monthDay" INTEGER NOT NULL DEFAULT 1,
    "format" TEXT NOT NULL DEFAULT 'XLSX',
    "recipientIds" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ScheduledReport_clinicId_idx" ON "ScheduledReport"("clinicId");
CREATE INDEX "ScheduledReport_enabled_nextRunAt_idx" ON "ScheduledReport"("enabled", "nextRunAt");
ALTER TABLE "ScheduledReport" ADD CONSTRAINT "ScheduledReport_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 7,
    "hours" INTEGER NOT NULL DEFAULT 4,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastFiredAt" TIMESTAMP(3),
    "lastValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AlertRule_clinicId_kind_key" ON "AlertRule"("clinicId", "kind");
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
