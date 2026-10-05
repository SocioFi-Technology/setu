-- ADR 0015 clinical-safety review (B3–B4 session 2): the amount given on a multi-dose dose (insulin by sliding scale);
-- the guard requires a witness for controlled drugs too (never the giver or the preparer), an opened vial for a
-- multi-dose drug from ward stock, PRN doses charted within the hour, and no slot charted more than 12 hours ahead.
ALTER TABLE "MedicationAdministration" ADD COLUMN "amountGiven" TEXT;

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
    -- charted when given: a PRN dose backdated beyond the window would slip between the two cap windows below
    IF NEW."administeredAt" < (now() AT TIME ZONE 'UTC') - interval '62 minutes' THEN RAISE EXCEPTION 'MedicationAdministration: a PRN dose is charted within the hour it is given'; END IF;
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
    IF NEW."scheduledFor" > (now() AT TIME ZONE 'UTC') + interval '12 hours' THEN RAISE EXCEPTION 'MedicationAdministration: a slot more than 12 hours ahead is not charted'; END IF;
    IF NEW."status" = 'missed' AND NEW."scheduledFor" + interval '60 minutes' > (now() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'MedicationAdministration: missed only after the window has passed'; END IF;
  END IF;
  SELECT * INTO m FROM "Medicine" WHERE "tenantId" = NEW."tenantId" AND "key" = NEW."medicineKey";
  IF NEW."highAlert" IS DISTINCT FROM coalesce(m."highAlert", false) OR NEW."controlled" IS DISTINCT FROM coalesce(m."controlled", false) THEN RAISE EXCEPTION 'MedicationAdministration: the high-alert / controlled flags are the medicine''s'; END IF;
  IF NEW."status" = 'given' AND (m."highAlert" OR m."controlled") THEN
    IF NEW."witnessedById" IS NULL THEN RAISE EXCEPTION 'MedicationAdministration: a high-alert or controlled drug is given with a witness'; END IF;
    IF NEW."witnessedById" IN (NEW."administeredById", NEW."preparedById") THEN RAISE EXCEPTION 'MedicationAdministration: the giver or the preparer is not the witness'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "PractitionerRole" pr JOIN "User" u ON u."id" = pr."userId" WHERE pr."userId" = NEW."witnessedById" AND pr."organizationId" = NEW."organizationId" AND pr."role" IN ('nurse', 'doctor') AND u."active") THEN
      RAISE EXCEPTION 'MedicationAdministration: the witness is a nurse or a doctor of this facility';
    END IF;
  END IF;
  -- a multi-dose vial: the amount given is recorded, and from ward stock a vial of it is open for this patient
  IF NEW."status" = 'given' AND m."multiDose" THEN
    IF char_length(btrim(coalesce(NEW."amountGiven", ''))) = 0 THEN RAISE EXCEPTION 'MedicationAdministration: a multi-dose drug records the amount given'; END IF;
    IF NEW."source" = 'ward-stock' AND NOT EXISTS (SELECT 1 FROM "MultiDoseVial" v WHERE v."encounterId" = NEW."encounterId" AND v."medicineKey" = NEW."medicineKey" AND v."source" = 'ward-stock' AND v."openedAt" <= NEW."administeredAt" + interval '2 minutes') THEN
      RAISE EXCEPTION 'MedicationAdministration: no opened vial of this medicine for this patient';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
