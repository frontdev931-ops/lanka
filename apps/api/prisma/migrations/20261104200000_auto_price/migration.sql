-- Imported services follow Cliniccards by themselves; what the clinic changed by hand stays as a local exception
ALTER TABLE "KbItem" ADD COLUMN "localFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Legacy: a price that differs from the source (or an explicit 0: a draft never took 0 from the source) was set by hand
UPDATE "KbItem" SET "localFields" = array_append("localFields", 'priceUah')
WHERE "externalId" IS NOT NULL AND "kind" = 'SERVICE' AND "priceUah" IS NOT NULL AND ("externalPrice" IS NULL OR "priceUah" <> "externalPrice" OR "priceUah" = 0);

-- A title that differs from the source, and a text of an approved position (it may have been edited), stay as they are
UPDATE "KbItem" SET "localFields" = array_append("localFields", 'title')
WHERE "externalId" IS NOT NULL AND "kind" = 'SERVICE' AND "externalTitle" IS NOT NULL AND "title" <> "externalTitle";
UPDATE "KbItem" SET "localFields" = array_append("localFields", 'text')
WHERE "externalId" IS NOT NULL AND "kind" = 'SERVICE' AND "approvedAt" IS NOT NULL AND "text" <> '';

-- Positions imported as drafts become ordinary imported services (no manual approval of every position)
UPDATE "KbItem" SET "approvedAt" = NOW(), "reviewedAt" = NOW()
WHERE "externalId" IS NOT NULL AND "source" = 'CLINICCARDS' AND "kind" = 'SERVICE' AND "approvedAt" IS NULL;
