-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsage_clinicId_createdAt_idx" ON "AiUsage"("clinicId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
