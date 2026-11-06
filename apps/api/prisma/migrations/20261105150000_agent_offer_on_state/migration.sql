-- The sent offer of times is remembered on the dialogue's state (no booking request exists until the patient chooses a time)
ALTER TABLE "BookingRequest" DROP COLUMN "offerMessageId", DROP COLUMN "offeredAt";
ALTER TABLE "ConversationState" ADD COLUMN "offerMessageId" TEXT, ADD COLUMN "offeredAt" TIMESTAMP(3), ADD COLUMN "offerService" TEXT;
