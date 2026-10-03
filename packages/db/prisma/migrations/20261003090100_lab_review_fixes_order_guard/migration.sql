-- Fix of lab_review_fixes: specimen_order_guard read the order id from a record that does not carry it (every label
-- print failed with "record o has no field id"); it now uses the new row's serviceRequestId. An applied migration is
-- never edited, so the corrected function is replaced here.

CREATE OR REPLACE FUNCTION specimen_order_guard() RETURNS trigger AS $$
DECLARE sp RECORD; o RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'SpecimenOrder: the tests on a tube never change'; END IF;
  SELECT "status", "encounterId" INTO sp FROM "Specimen" WHERE "id" = NEW."specimenId";
  SELECT "status", "encounterId", "group" INTO o FROM "ServiceRequest" WHERE "id" = NEW."serviceRequestId";
  IF sp IS NULL OR o IS NULL OR sp."status" <> 'pending' OR sp."encounterId" <> o."encounterId" OR o."group" <> 'lab' OR o."status" IN ('draft', 'revoked', 'declined')
     -- clinical review H1: a released (complete) test whose results were withdrawn needs a new tube
     OR (o."status" = 'complete' AND EXISTS (SELECT 1 FROM "Observation" x WHERE x."serviceRequestId" = NEW."serviceRequestId" AND x."category" = 'laboratory' AND x."status" <> 'entered-in-error')) THEN
    RAISE EXCEPTION 'SpecimenOrder: a placed lab order of the same visit without current results, on a tube not yet collected';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
