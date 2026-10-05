-- ADR 0016 guards (after the enums above are committed).
CREATE OR REPLACE FUNCTION medication_administration_guard() RETURNS trigger AS $$
DECLARE r RECORD; c RECORD; e RECORD; m RECORD; given_n int;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'MedicationAdministration %: a recorded dose is never deleted', OLD."id"; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'entered-in-error' OR NEW."status" <> 'entered-in-error'
       OR (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt', 'errorStockDrawn']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt', 'errorStockDrawn'])
       OR (NEW."errorStockDrawn" IS NOT NULL AND NEW."errorStockDrawn" NOT IN ('yes', 'no', 'unsure'))
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
  -- ADR 0016 scan-to-verify: a given dose has its wristband scan (and, from ward stock, its medicine label: a ward batch of
  -- this medicine, not expired) — or a "scanner not working" reason (≥10), never for a high-alert or controlled drug
  IF NEW."status" = 'given' THEN
    IF NEW."scanOverrideReason" IS NOT NULL AND (m."highAlert" OR m."controlled" OR char_length(btrim(NEW."scanOverrideReason")) < 10) THEN
      RAISE EXCEPTION 'MedicationAdministration: no scan override for a high-alert or controlled drug; an override has a reason';
    END IF;
    IF NEW."scanOverrideReason" IS NULL AND (NEW."scanBandAt" IS NULL OR (NEW."source" = 'ward-stock' AND NEW."scanMedBatchId" IS NULL)) THEN
      RAISE EXCEPTION 'MedicationAdministration: a given dose is scanned — wristband, and from ward stock the medicine label';
    END IF;
    IF NEW."scanMedBatchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "StockBatch" b WHERE b."id" = NEW."scanMedBatchId" AND b."organizationId" = NEW."organizationId"
         AND b."medicineKey" = NEW."medicineKey" AND b."location" LIKE 'ward:%' AND b."expiry" >= to_char((now() AT TIME ZONE 'UTC') + interval '6 hours', 'YYYY-MM-DD')) THEN
      RAISE EXCEPTION 'MedicationAdministration: the scanned label is not a ward batch of this medicine in date';
    END IF;
  ELSIF NEW."scanOverrideReason" IS NOT NULL THEN
    RAISE EXCEPTION 'MedicationAdministration: a scan override is for a given dose only';
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

-- ───── intake / output: append-only, written by the signed-in user; only marked entered-in-error by its writer ─────
ALTER TABLE "IntakeOutputEntry" ADD CONSTRAINT intake_output_shape CHECK (
  ("side" = 'in' AND "route" IN ('oral', 'iv', 'ng', 'other')) OR ("side" = 'out' AND "route" IN ('urine', 'drain', 'vomit', 'stool', 'ng-aspirate', 'other')))
  ;
ALTER TABLE "IntakeOutputEntry" ADD CONSTRAINT intake_output_ml CHECK ("ml" BETWEEN 1 AND 5000);
CREATE OR REPLACE FUNCTION intake_output_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'IntakeOutputEntry: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active' OR NEW."errorAt" IS NOT NULL OR NOT lab_actor_ok(NEW."writtenById") OR NEW."effectiveAt" > (now() AT TIME ZONE 'UTC') + interval '2 minutes' THEN
      RAISE EXCEPTION 'IntakeOutputEntry: written by the signed-in user, not in the future';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'active' OR NEW."status" <> 'entered-in-error'
     OR (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt'])
     OR NEW."errorById" IS DISTINCT FROM OLD."writtenById" OR NOT lab_actor_ok(NEW."errorById") OR NEW."errorAt" IS NULL OR char_length(btrim(coalesce(NEW."errorReason", ''))) < 5 THEN
    RAISE EXCEPTION 'IntakeOutputEntry %: never changed — only marked entered-in-error by its writer with a reason', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER intake_output_guard BEFORE INSERT OR UPDATE OR DELETE ON "IntakeOutputEntry" FOR EACH ROW EXECUTE FUNCTION intake_output_guard();

-- ───── care plan tasks: CARE_TASK; ticked by a nurse; a cancel has a reason ─────
ALTER TABLE "CareTask" ADD CONSTRAINT care_task_shape CHECK (char_length(btrim("text")) BETWEEN 3 AND 300 AND ("everyHours" IS NULL OR "everyHours" BETWEEN 1 AND 24));
CREATE OR REPLACE FUNCTION care_task_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CareTask: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'requested' OR NOT lab_actor_ok(NEW."createdById") THEN RAISE EXCEPTION 'CareTask: written by the signed-in user, as requested'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'requested' THEN RAISE EXCEPTION 'CareTask %: a done or cancelled task never changes', OLD."id"; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'completedById', 'completedAt', 'cancelledById', 'cancelledAt', 'cancelReason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'completedById', 'completedAt', 'cancelledById', 'cancelledAt', 'cancelReason']) THEN
    RAISE EXCEPTION 'CareTask %: what the task is never changes', OLD."id";
  END IF;
  IF NEW."status" = 'completed' AND (NEW."completedAt" IS NULL OR NOT lab_actor_ok(NEW."completedById")
     OR NOT EXISTS (SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = NEW."completedById" AND r."organizationId" = NEW."organizationId" AND r."role" = 'nurse')) THEN
    RAISE EXCEPTION 'CareTask %: ticked by a nurse of this facility, signed in', OLD."id";
  END IF;
  IF NEW."status" = 'cancelled' AND (NEW."cancelledAt" IS NULL OR NOT lab_actor_ok(NEW."cancelledById") OR char_length(btrim(coalesce(NEW."cancelReason", ''))) < 5) THEN
    RAISE EXCEPTION 'CareTask %: cancelled by the signed-in user with a reason', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER care_task_guard BEFORE INSERT OR UPDATE OR DELETE ON "CareTask" FOR EACH ROW EXECUTE FUNCTION care_task_guard();

-- ───── the handover: HANDOVER; signed when every patient is reviewed; accepted by another nurse; accepted is final ─────
CREATE OR REPLACE FUNCTION handover_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Handover: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' OR NOT lab_actor_ok(NEW."outgoingId") THEN RAISE EXCEPTION 'Handover: started as a draft by the signed-in nurse'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'accepted' THEN RAISE EXCEPTION 'Handover %: an accepted handover never changes', OLD."id"; END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."wardId", NEW."shiftDay", NEW."shiftStartHour", NEW."outgoingId", NEW."createdAt")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."wardId", OLD."shiftDay", OLD."shiftStartHour", OLD."outgoingId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Handover %: which ward, shift and outgoing nurse never change', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('draft>outgoing-signed', 'outgoing-signed>accepted', 'outgoing-signed>draft') THEN
    RAISE EXCEPTION 'Handover %: cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF NEW."status" = 'outgoing-signed' AND OLD."status" = 'draft' THEN
    IF NEW."signedAt" IS NULL OR NOT lab_actor_ok(OLD."outgoingId") THEN RAISE EXCEPTION 'Handover %: signed by the outgoing nurse', OLD."id"; END IF;
    IF EXISTS (SELECT 1 FROM "HandoverPatient" p WHERE p."handoverId" = OLD."id" AND NOT p."reviewed") THEN RAISE EXCEPTION 'Handover %: every patient is reviewed before signing', OLD."id"; END IF;
  END IF;
  IF NEW."status" = 'accepted' THEN
    IF NEW."incomingId" IS NULL OR NEW."incomingId" = OLD."outgoingId" OR NOT lab_actor_ok(NEW."incomingId") OR NEW."acceptedAt" IS NULL
       OR NOT EXISTS (SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = NEW."incomingId" AND r."organizationId" = NEW."organizationId" AND r."role" = 'nurse') THEN
      RAISE EXCEPTION 'Handover %: accepted by another nurse of this facility, signed in', OLD."id";
    END IF;
  END IF;
  IF NEW."status" = 'draft' AND OLD."status" = 'outgoing-signed' AND (char_length(btrim(coalesce(NEW."queryNote", ''))) < 5 OR NEW."queriedAt" IS NULL OR NOT lab_actor_ok(NEW."queriedById")) THEN
    RAISE EXCEPTION 'Handover %: a query has a note', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER handover_guard BEFORE INSERT OR UPDATE OR DELETE ON "Handover" FOR EACH ROW EXECUTE FUNCTION handover_guard();
CREATE OR REPLACE FUNCTION handover_patient_guard() RETURNS trigger AS $$
DECLARE h RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'HandoverPatient: never deleted'; END IF;
  SELECT * INTO h FROM "Handover" WHERE "id" = NEW."handoverId";
  IF h."status" <> 'draft' THEN RAISE EXCEPTION 'HandoverPatient: the sheet changes only while the handover is a draft'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER handover_patient_guard BEFORE INSERT OR UPDATE OR DELETE ON "HandoverPatient" FOR EACH ROW EXECUTE FUNCTION handover_patient_guard();

-- Row-level security for the new tables (same loop as rls.sql); nothing here is ever deleted.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE column_name = 'tenantId' AND table_schema = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;
REVOKE DELETE ON "IntakeOutputEntry", "CareTask", "Handover", "HandoverPatient" FROM setu_app;
