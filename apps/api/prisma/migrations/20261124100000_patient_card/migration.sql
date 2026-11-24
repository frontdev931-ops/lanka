-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "curator" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "phone2" TEXT,
ADD COLUMN     "subclinic" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

