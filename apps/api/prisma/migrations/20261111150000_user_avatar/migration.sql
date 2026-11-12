-- The person's own photo for the side panel and the profile: a small raster image as a data URI, checked by the server
ALTER TABLE "User" ADD COLUMN "avatar" TEXT;
