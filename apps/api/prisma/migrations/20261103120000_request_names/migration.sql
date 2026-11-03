-- The surname and the first name of a person who writes to the bot are separate fields (never guessed from the order of words)
ALTER TABLE "BookingRequest" ADD COLUMN "lastName" TEXT, ADD COLUMN "firstName" TEXT, ADD COLUMN "askField" TEXT;
