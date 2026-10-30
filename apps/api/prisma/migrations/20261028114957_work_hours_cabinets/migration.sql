-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "workHours" JSONB;

-- CreateTable
CREATE TABLE "Cabinet" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Cabinet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cabinet_clinicId_externalId_key" ON "Cabinet"("clinicId", "externalId");

-- AddForeignKey
ALTER TABLE "Cabinet" ADD CONSTRAINT "Cabinet_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
