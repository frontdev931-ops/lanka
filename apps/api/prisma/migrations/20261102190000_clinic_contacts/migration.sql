-- The clinic's public contacts for the chat assistant (address, phone of the administrator, how to get there)
ALTER TABLE "Clinic" ADD COLUMN "publicAddress" TEXT, ADD COLUMN "publicPhone" TEXT, ADD COLUMN "publicDirections" TEXT;
