-- The approved agent offer, the patient's consent and the visit are linked to the one booking request of the dialogue
ALTER TABLE "BookingRequest" ADD COLUMN "offerMessageId" TEXT,
ADD COLUMN "offeredAt" TIMESTAMP(3),
ADD COLUMN "consentKey" TEXT,
ADD COLUMN "consentAt" TIMESTAMP(3),
ADD COLUMN "consentMessageId" TEXT;
ALTER TABLE "ConversationState" ADD COLUMN "bookingRequestId" TEXT;
