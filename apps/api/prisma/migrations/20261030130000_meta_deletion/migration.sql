CREATE TABLE "DataDeletionRequest" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'META',
    "externalUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataDeletionRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DataDeletionRequest_code_key" ON "DataDeletionRequest"("code");
CREATE INDEX "DataDeletionRequest_externalUserId_idx" ON "DataDeletionRequest"("externalUserId");
