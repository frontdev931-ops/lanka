CREATE TABLE "RevokedToken" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevokedToken_pkey" PRIMARY KEY ("jti")
);
CREATE INDEX "RevokedToken_expiresAt_idx" ON "RevokedToken"("expiresAt");
