-- ADR 0014: the reason a bed is blocked / the cleaning under way, shown on the bed map.
ALTER TABLE "Location" ADD COLUMN "bedNote" TEXT;
