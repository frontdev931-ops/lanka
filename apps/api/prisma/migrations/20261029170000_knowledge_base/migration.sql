CREATE TABLE "KbItem" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "durationMin" INTEGER,
    "priceUah" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KbItem_clinicId_kind_externalId_key" ON "KbItem"("clinicId", "kind", "externalId");
CREATE INDEX "KbItem_clinicId_kind_idx" ON "KbItem"("clinicId", "kind");
ALTER TABLE "KbItem" ADD CONSTRAINT "KbItem_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
