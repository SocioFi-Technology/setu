-- Slice C1–C4 session 2: fixes from the security and money-controls reviews (database side).
-- • security #1 / money L1: closed → approved / open only with the matching ShiftReview on the latest count, by someone
--   other than the cashier (inserted first in the same transaction); counted → open removed (no route uses it);
-- • security #2: latestCountId moves only with open → counted, to this shift's newest count;
-- • security #10: a count's window and time cannot be in the future.
CREATE OR REPLACE FUNCTION shift_guard() RETURNS trigger AS $$
DECLARE rv RECORD; newest RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Shift %: a shift is never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'open' OR NEW."latestCountId" IS NOT NULL THEN RAISE EXCEPTION 'Shift: a new shift starts open'; END IF;
    IF NOT lab_actor_ok(NEW."cashierId") THEN RAISE EXCEPTION 'Shift: a cashier opens their own shift'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."cashierId", NEW."openingFloatPaisa", NEW."openedAt")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."cashierId", OLD."openingFloatPaisa", OLD."openedAt") THEN
    RAISE EXCEPTION 'Shift %: whose shift it is and its float never change', OLD."id";
  END IF;
  IF OLD."status" = 'approved' THEN RAISE EXCEPTION 'Shift %: an approved shift is final', OLD."id"; END IF;
  IF NEW."status" <> OLD."status" AND (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('open>counted', 'counted>closed', 'closed>approved', 'closed>open') THEN
    RAISE EXCEPTION 'Shift %: SHIFT cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  -- the latest count changes only when counting, and only to this shift's newest count
  IF NEW."latestCountId" IS DISTINCT FROM OLD."latestCountId" THEN
    IF NOT (OLD."status" = 'open' AND NEW."status" = 'counted') THEN RAISE EXCEPTION 'Shift %: the latest count changes only when counting', OLD."id"; END IF;
    SELECT "id" INTO newest FROM "ShiftCount" WHERE "shiftId" = OLD."id" ORDER BY "countNo" DESC LIMIT 1;
    IF NOT FOUND OR newest."id" <> NEW."latestCountId" THEN RAISE EXCEPTION 'Shift %: the latest count must be this shift''s newest count', OLD."id"; END IF;
  END IF;
  -- approve and recount need the owner's / admin's decision row on the latest count (never by the cashier)
  IF OLD."status" = 'closed' AND NEW."status" IN ('approved', 'open') THEN
    SELECT * INTO rv FROM "ShiftReview" WHERE "shiftId" = OLD."id" AND "countId" = OLD."latestCountId"
      AND "decision" = CASE NEW."status" WHEN 'approved' THEN 'approve' ELSE 'recount' END ORDER BY "at" DESC LIMIT 1;
    IF NOT FOUND OR rv."byId" = OLD."cashierId" THEN RAISE EXCEPTION 'Shift %: a decision on the latest count by the owner or admin is required', OLD."id"; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION shift_count_guard() RETURNS trigger AS $$
DECLARE s RECORD;
BEGIN
  SELECT * INTO s FROM "Shift" WHERE "id" = NEW."shiftId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'ShiftCount: no such shift'; END IF;
  IF s."status" <> 'open' THEN RAISE EXCEPTION 'ShiftCount: only an open shift is counted'; END IF;
  IF NEW."countedById" <> s."cashierId" OR NOT lab_actor_ok(NEW."countedById") THEN RAISE EXCEPTION 'ShiftCount: the cashier counts their own drawer'; END IF;
  IF NEW."openingFloatPaisa" <> s."openingFloatPaisa" OR NEW."windowFrom" <> s."openedAt" THEN RAISE EXCEPTION 'ShiftCount: the float and the window start are the shift''s'; END IF;
  IF NEW."windowTo" > now() + interval '5 minutes' OR NEW."countedAt" > now() + interval '5 minutes' THEN RAISE EXCEPTION 'ShiftCount: a count cannot be in the future'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
