-- The reason a booking went to the administrator instead of being offered online
ALTER TABLE "BookingRequest" ADD COLUMN "blockCode" TEXT;
