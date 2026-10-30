-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "sessionsValidAfter" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_type_idx" ON "AuthToken"("userId", "type");

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Пользователи, созданные до появления подтверждения почты, считаются подтверждёнными
-- (это тестовые и локальные аккаунты; в новой базе продакшена строк User ещё нет).
UPDATE "User" SET "emailVerifiedAt" = NOW() WHERE "emailVerifiedAt" IS NULL;
