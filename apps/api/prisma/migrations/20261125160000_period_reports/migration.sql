-- Weekly and monthly reports to managers (2026-11-25). Every new switch is off and no run is created by the migration, so the deploy sends nothing.
ALTER TABLE "Clinic" ADD COLUMN "weeklyReportOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "weeklyReportWeekday" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Clinic" ADD COLUMN "weeklyReportHour" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "Clinic" ADD COLUMN "weeklyReportSince" TIMESTAMP(3);
ALTER TABLE "Clinic" ADD COLUMN "monthlyReportOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "monthlyReportHour" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "Clinic" ADD COLUMN "monthlyReportSince" TIMESTAMP(3);

ALTER TABLE "LeaderTelegram" ADD COLUMN "weekly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeaderTelegram" ADD COLUMN "weeklySince" TIMESTAMP(3);
ALTER TABLE "LeaderTelegram" ADD COLUMN "monthly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeaderTelegram" ADD COLUMN "monthlySince" TIMESTAMP(3);

CREATE TABLE "PeriodReportRun" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodFrom" TEXT NOT NULL,
    "periodTo" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PeriodReportRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PeriodReportDelivery" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodFrom" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PeriodReportDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PeriodReportRun_clinicId_kind_periodFrom_key" ON "PeriodReportRun"("clinicId", "kind", "periodFrom");
CREATE UNIQUE INDEX "PeriodReportDelivery_clinicId_userId_kind_periodFrom_key" ON "PeriodReportDelivery"("clinicId", "userId", "kind", "periodFrom");
CREATE INDEX "PeriodReportDelivery_clinicId_status_idx" ON "PeriodReportDelivery"("clinicId", "status");

ALTER TABLE "PeriodReportRun" ADD CONSTRAINT "PeriodReportRun_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PeriodReportDelivery" ADD CONSTRAINT "PeriodReportDelivery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PeriodReportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
