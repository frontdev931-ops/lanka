-- Website integration: form enquiries with a public browser key and a separate server secret; the widget's appearance; explicit AI in the website chat
ALTER TABLE "Clinic" ADD COLUMN "widgetColor" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "widgetPosition" TEXT NOT NULL DEFAULT 'RIGHT';
ALTER TABLE "Clinic" ADD COLUMN "widgetVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Clinic" ADD COLUMN "aiWebAuto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "leadSecretHash" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "leadSecretHint" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "leadVerifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Clinic_leadSecretHash_key" ON "Clinic"("leadSecretHash");

ALTER TABLE "Inquiry" ADD COLUMN "email" TEXT;
ALTER TABLE "Inquiry" ADD COLUMN "via" TEXT;
ALTER TABLE "Inquiry" ADD COLUMN "formId" TEXT;
ALTER TABLE "Inquiry" ADD COLUMN "referrer" TEXT;
