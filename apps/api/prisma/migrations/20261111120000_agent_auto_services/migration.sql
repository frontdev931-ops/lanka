-- The autonomous agent's explicit set of services (up to five, chosen by the service owner) replaces the one test service. The old single value is copied
-- into the list (the effective permission stays the same); "set" tells an explicitly configured list (authoritative, an empty one disables autonomy) from a
-- clinic that was never configured (whose old single value still applies, see AgentAutoGate)
ALTER TABLE "Clinic" ADD COLUMN "agentAutoServiceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "agentAutoServicesSet" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Clinic" SET "agentAutoServiceIds" = ARRAY["agentAutoServiceId"] WHERE "agentAutoServiceId" IS NOT NULL;
