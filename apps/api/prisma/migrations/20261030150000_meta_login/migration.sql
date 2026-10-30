CREATE TABLE "MetaConnectSession" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "tokenInfo" JSONB NOT NULL,
    "pages" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaConnectSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MetaConnectSession_clinicId_idx" ON "MetaConnectSession"("clinicId");
ALTER TABLE "MetaConnectSession" ADD CONSTRAINT "MetaConnectSession_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
