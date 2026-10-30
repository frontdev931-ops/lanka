ALTER TYPE "Provider" ADD VALUE 'MESSENGER';
ALTER TYPE "Provider" ADD VALUE 'WHATSAPP';
ALTER TYPE "Provider" ADD VALUE 'VIBER';

ALTER TABLE "Clinic" ADD COLUMN "widgetKey" TEXT,
ADD COLUMN "widgetEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "widgetOrigins" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "widgetGreeting" TEXT;
CREATE UNIQUE INDEX "Clinic_widgetKey_key" ON "Clinic"("widgetKey");

ALTER TABLE "ChatMessage" ADD COLUMN "buttons" JSONB;
