-- CreateIndex
CREATE INDEX "Visit_patientId_startsAt_idx" ON "Visit"("patientId", "startsAt");
