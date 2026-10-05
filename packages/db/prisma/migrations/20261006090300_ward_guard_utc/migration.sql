-- ADR 0015: timestamps are stored as UTC without a zone — the slot's Dhaka time of day is (ts AT TIME ZONE 'UTC') AT
-- TIME ZONE 'Asia/Dhaka', and "now" is compared in UTC whatever the server's time zone.
CREATE OR REPLACE FUNCTION medication_administration_guard() RETURNS trigger AS $$
DECLARE r RECORD; c RECORD; e RECORD; m RECORD; given_n int;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'MedicationAdministration %: a recorded dose is never deleted', OLD."id"; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'entered-in-error' OR NEW."status" <> 'entered-in-error'
       OR (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt'])
       OR NEW."errorAt" IS NULL OR char_length(btrim(coalesce(NEW."errorReason", ''))) < 5 OR NOT lab_actor_ok(NEW."errorById") THEN
      RAISE EXCEPTION 'MedicationAdministration %: a recorded dose is never changed — only marked entered-in-error with who, when and why', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'entered-in-error' OR NEW."errorAt" IS NOT NULL THEN RAISE EXCEPTION 'MedicationAdministration: a new record is not entered-in-error'; END IF;
  IF NOT lab_actor_ok(NEW."administeredById") THEN RAISE EXCEPTION 'MedicationAdministration: recorded by someone other than the signed-in user'; END IF;
  -- the order row is locked: two doses at once see each other (the slot index and the PRN count)
  SELECT * INTO r FROM "MedicationRequest" WHERE "id" = NEW."requestId" AND "tenantId" = NEW."tenantId" FOR UPDATE;
  IF NOT FOUND OR r."kind" <> 'inpatient' THEN RAISE EXCEPTION 'MedicationAdministration: only an inpatient order takes a dose'; END IF;
  IF r."patientId" <> NEW."patientId" OR r."encounterId" <> NEW."encounterId" THEN RAISE EXCEPTION 'MedicationAdministration: the order is another patient''s or another visit''s'; END IF;
  SELECT * INTO c FROM "Composition" WHERE "id" = r."compositionId";
  IF r."orderStatus" <> 'active' OR c."status" NOT IN ('final', 'amended') THEN RAISE EXCEPTION 'MedicationAdministration: the order is % (note %) — only an active order takes a dose', r."orderStatus", c."status"; END IF;
  IF NEW."regimenId" <> r."regimenId" OR NEW."medicineKey" <> r."medicineKey" OR NEW."route" <> r."route" THEN RAISE EXCEPTION 'MedicationAdministration: the drug, route and regimen are the order''s'; END IF;
  SELECT * INTO e FROM "Encounter" WHERE "id" = NEW."encounterId";
  IF e."class" <> 'ipd' OR e."status" <> 'in-progress' THEN RAISE EXCEPTION 'MedicationAdministration: the inpatient visit is not open'; END IF;
  IF NEW."administeredAt" > (now() AT TIME ZONE 'UTC') + interval '2 minutes' THEN RAISE EXCEPTION 'MedicationAdministration: a dose is never recorded in the future'; END IF;
  IF NEW."administeredAt" < r."startAt" - interval '2 minutes' THEN RAISE EXCEPTION 'MedicationAdministration: before the order started'; END IF;
  IF r."prn" THEN
    IF NEW."scheduledFor" IS NOT NULL OR NEW."timing" <> 'prn' OR NEW."status" IN ('held', 'missed') THEN RAISE EXCEPTION 'MedicationAdministration: a PRN dose has no slot and is given or refused'; END IF;
    IF NEW."status" = 'given' THEN
      -- the 24 hours up to this dose, and (for a dose recorded late) the 24 hours from it
      SELECT count(*) INTO given_n FROM "MedicationAdministration" WHERE "regimenId" = NEW."regimenId" AND "status" = 'given'
        AND "administeredAt" > NEW."administeredAt" - interval '24 hours' AND "administeredAt" <= NEW."administeredAt";
      IF given_n + 1 > r."prnMaxPer24h" THEN RAISE EXCEPTION 'MedicationAdministration: PRN cap — % given in 24 hours, the order allows %', given_n, r."prnMaxPer24h"; END IF;
      SELECT count(*) INTO given_n FROM "MedicationAdministration" WHERE "regimenId" = NEW."regimenId" AND "status" = 'given'
        AND "administeredAt" >= NEW."administeredAt" AND "administeredAt" < NEW."administeredAt" + interval '24 hours';
      IF given_n + 1 > r."prnMaxPer24h" THEN RAISE EXCEPTION 'MedicationAdministration: PRN cap — % given in the 24 hours after, the order allows %', given_n, r."prnMaxPer24h"; END IF;
    END IF;
  ELSE
    IF NEW."scheduledFor" IS NULL OR NEW."timing" = 'prn' THEN RAISE EXCEPTION 'MedicationAdministration: a scheduled order''s dose is against its slot'; END IF;
    IF to_char((NEW."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'HH24:MI') <> ALL (r."times") OR NEW."scheduledFor" < r."startAt" OR date_part('second', NEW."scheduledFor") <> 0 THEN
      RAISE EXCEPTION 'MedicationAdministration: not a slot of the order';
    END IF;
    IF NEW."status" = 'missed' AND NEW."scheduledFor" + interval '60 minutes' > (now() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'MedicationAdministration: missed only after the window has passed'; END IF;
  END IF;
  SELECT * INTO m FROM "Medicine" WHERE "tenantId" = NEW."tenantId" AND "key" = NEW."medicineKey";
  IF NEW."highAlert" IS DISTINCT FROM coalesce(m."highAlert", false) OR NEW."controlled" IS DISTINCT FROM coalesce(m."controlled", false) THEN RAISE EXCEPTION 'MedicationAdministration: the high-alert / controlled flags are the medicine''s'; END IF;
  IF NEW."status" = 'given' AND m."highAlert" THEN
    IF NEW."witnessedById" IS NULL THEN RAISE EXCEPTION 'MedicationAdministration: a high-alert drug is given with a witness'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "PractitionerRole" pr JOIN "User" u ON u."id" = pr."userId" WHERE pr."userId" = NEW."witnessedById" AND pr."organizationId" = NEW."organizationId" AND pr."role" IN ('nurse', 'doctor') AND u."active") THEN
      RAISE EXCEPTION 'MedicationAdministration: the witness is a nurse or a doctor of this facility';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION multi_dose_vial_guard() RETURNS trigger AS $$
DECLARE r RECORD; c RECORD; e RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'MultiDoseVial: an opened vial is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."openedById") OR NEW."openedAt" > (now() AT TIME ZONE 'UTC') + interval '2 minutes' OR NEW."source" NOT IN ('ward-stock', 'patient-supplied') THEN RAISE EXCEPTION 'MultiDoseVial: opened by the signed-in user, not in the future'; END IF;
  SELECT * INTO r FROM "MedicationRequest" WHERE "id" = NEW."requestId" AND "tenantId" = NEW."tenantId";
  SELECT * INTO c FROM "Composition" WHERE "id" = r."compositionId";
  SELECT * INTO e FROM "Encounter" WHERE "id" = NEW."encounterId";
  IF r."kind" <> 'inpatient' OR r."orderStatus" <> 'active' OR c."status" NOT IN ('final', 'amended') OR r."patientId" <> NEW."patientId" OR r."encounterId" <> NEW."encounterId"
     OR r."regimenId" <> NEW."regimenId" OR r."medicineKey" <> NEW."medicineKey" OR e."class" <> 'ipd' OR e."status" <> 'in-progress' THEN
    RAISE EXCEPTION 'MultiDoseVial: an active order of this patient''s open inpatient visit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Medicine" WHERE "tenantId" = NEW."tenantId" AND "key" = NEW."medicineKey" AND "multiDose") THEN RAISE EXCEPTION 'MultiDoseVial: not a multi-dose medicine'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nursing_note_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'NursingNote: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active' OR NEW."errorAt" IS NOT NULL OR NOT lab_actor_ok(NEW."writtenById") OR NEW."effectiveAt" > (now() AT TIME ZONE 'UTC') + interval '2 minutes' THEN RAISE EXCEPTION 'NursingNote: written by the signed-in user, not in the future'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'active' OR NEW."status" <> 'entered-in-error'
     OR (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt'])
     OR NEW."errorAt" IS NULL OR char_length(btrim(coalesce(NEW."errorReason", ''))) < 5 OR NOT lab_actor_ok(NEW."errorById") THEN
    RAISE EXCEPTION 'NursingNote %: a note is never edited — only marked entered-in-error with who, when and why', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
