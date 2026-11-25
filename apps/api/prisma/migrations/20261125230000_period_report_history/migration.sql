-- History of weekly and monthly reports (2026-11-25). Existing runs become SCHEDULED with no saved text ({}): their old text is not invented.
ALTER TABLE "PeriodReportRun" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'SCHEDULED';
ALTER TABLE "PeriodReportRun" ADD COLUMN "dedupeKey" TEXT NOT NULL DEFAULT 'SCHEDULED';
ALTER TABLE "PeriodReportRun" ADD COLUMN "createdById" TEXT;
ALTER TABLE "PeriodReportRun" ADD COLUMN "texts" JSONB NOT NULL DEFAULT '{}';
DROP INDEX "PeriodReportRun_clinicId_kind_periodFrom_key";
CREATE UNIQUE INDEX "PeriodReportRun_clinicId_kind_periodFrom_dedupeKey_key" ON "PeriodReportRun"("clinicId", "kind", "periodFrom", "dedupeKey");
CREATE INDEX "PeriodReportRun_clinicId_createdAt_idx" ON "PeriodReportRun"("clinicId", "createdAt");

ALTER TABLE "PeriodReportDelivery" ADD COLUMN "lang" TEXT;
DROP INDEX "PeriodReportDelivery_clinicId_userId_kind_periodFrom_key";
CREATE UNIQUE INDEX "PeriodReportDelivery_runId_userId_key" ON "PeriodReportDelivery"("runId", "userId");
