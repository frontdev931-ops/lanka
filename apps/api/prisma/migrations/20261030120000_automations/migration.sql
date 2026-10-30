CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'service',
    "trigger" JSONB NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "action" JSONB NOT NULL,
    "stop" JSONB NOT NULL DEFAULT '{}',
    "templateKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Automation_clinicId_enabled_idx" ON "Automation"("clinicId", "enabled");
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AutomationHit" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationHit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AutomationHit_automationId_dedupeKey_key" ON "AutomationHit"("automationId", "dedupeKey");
CREATE INDEX "AutomationHit_clinicId_createdAt_idx" ON "AutomationHit"("clinicId", "createdAt");
ALTER TABLE "AutomationHit" ADD CONSTRAINT "AutomationHit_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "candidates" INTEGER NOT NULL,
    "queued" INTEGER NOT NULL,
    "requests" INTEGER NOT NULL,
    "skipped" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AutomationRun_automationId_at_idx" ON "AutomationRun"("automationId", "at");
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
