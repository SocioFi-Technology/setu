-- ADR 0015 guards (after the tables and enums above are committed).

-- ───── stock: ward locations; giving a dose takes stock out of the ward ─────
ALTER TABLE "StockBatch" DROP CONSTRAINT stock_batch_shape;
ALTER TABLE "StockBatch" ADD CONSTRAINT stock_batch_shape CHECK (
  "qtyOnHand" >= 0 AND "costPaisa" >= 0 AND "mrpPaisa" >= 0 AND "vatRateBp" BETWEEN 0 AND 10000
  AND "expiry" ~ '^\d{4}-\d{2}-\d{2}$' AND ("location" IN ('counter', 'store', 'fridge', 'quarantine') OR "location" ~ '^ward:[A-Za-z0-9_-]+$'));
ALTER TABLE "StockMove" DROP CONSTRAINT stock_move_shape;
ALTER TABLE "StockMove" ADD CONSTRAINT stock_move_shape CHECK (
  "qty" <> 0 AND "kind" IN ('receive', 'dispense', 'sale', 'adjust', 'return', 'transfer', 'administer')
  AND ("kind" NOT IN ('dispense', 'sale', 'administer') OR "qty" < 0) AND ("kind" <> 'receive' OR "qty" > 0)
  AND ("kind" <> 'adjust' OR char_length(btrim(coalesce("reason", ''))) >= 10));

-- ───── a signed note keeps its thread with everything else ─────
CREATE OR REPLACE FUNCTION composition_guard() RETURNS trigger AS $$
DECLARE pr RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Composition is never deleted (rule 3)'; END IF;
  IF OLD."status" = 'draft' THEN
    IF NEW."status" IN ('final', 'amended') AND NEW."signedById" IS NOT NULL THEN
      SELECT "regBody", "regNo", "regVerified" INTO pr FROM "Practitioner" WHERE "userId" = NEW."signedById";
      NEW."signerRegBody" := pr."regBody"; NEW."signerRegNo" := pr."regNo"; NEW."signerRegVerified" := coalesce(pr."regVerified", false);
    END IF;
    IF NEW."threadId" IS DISTINCT FROM OLD."threadId" THEN RAISE EXCEPTION 'Composition %: the thread never changes', OLD."id"; END IF;
    RETURN NEW;
  END IF;
  IF NOT (OLD."status" IN ('final', 'amended') AND NEW."status" IN ('superseded', 'entered-in-error')) THEN
    RAISE EXCEPTION 'Composition %: a signed version cannot change from % to % (rule 3)', OLD."id", OLD."status", NEW."status";
  END IF;
  IF (NEW."sections", NEW."sectionSources", NEW."version", NEW."encounterId", NEW."patientId", NEW."tenantId", NEW."kind",
      NEW."amendsId", NEW."amendReason", NEW."authorId", NEW."signedAt", NEW."signedById", NEW."aiReviewed", NEW."rev",
      NEW."uncodedAllergiesChecked", NEW."organizationId", NEW."branchId", NEW."createdAt",
      NEW."signerRegBody", NEW."signerRegNo", NEW."signerRegVerified", NEW."threadId")
     IS DISTINCT FROM
     (OLD."sections", OLD."sectionSources", OLD."version", OLD."encounterId", OLD."patientId", OLD."tenantId", OLD."kind",
      OLD."amendsId", OLD."amendReason", OLD."authorId", OLD."signedAt", OLD."signedById", OLD."aiReviewed", OLD."rev",
      OLD."uncodedAllergiesChecked", OLD."organizationId", OLD."branchId", OLD."createdAt",
      OLD."signerRegBody", OLD."signerRegNo", OLD."signerRegVerified", OLD."threadId") THEN
    RAISE EXCEPTION 'Composition %: a signed version is never edited — amend it (rule 3)', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ───── inpatient orders: the shape; on a signed note only the order's state moves (MEDICATION_ORDER) ─────
ALTER TABLE "MedicationRequest" ADD CONSTRAINT medication_request_kind CHECK ("kind" IN ('opd', 'inpatient'));
ALTER TABLE "MedicationRequest" ADD CONSTRAINT medication_request_inpatient CHECK ("kind" <> 'inpatient' OR (
  "route" IS NOT NULL AND char_length(btrim(coalesce("doseText", ''))) >= 1
  AND (("prn" AND cardinality("times") = 0 AND "prnMaxPer24h" BETWEEN 1 AND 24) OR (NOT "prn" AND cardinality("times") BETWEEN 1 AND 24 AND "prnMaxPer24h" IS NULL))
  AND ("doseQty" IS NULL OR "doseQty" BETWEEN 1 AND 20)));
ALTER TABLE "MedicationRequest" ADD CONSTRAINT medication_request_opd CHECK ("kind" <> 'opd' OR ("orderStatus" = 'active' AND NOT "prn" AND cardinality("times") = 0));
DROP TRIGGER medication_request_guard ON "MedicationRequest";
CREATE OR REPLACE FUNCTION medication_request_guard() RETURNS trigger AS $$
DECLARE st "DocumentStatus";
BEGIN
  SELECT "status" INTO st FROM "Composition" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."compositionId" ELSE NEW."compositionId" END);
  IF st = 'draft' THEN
    IF TG_OP = 'UPDATE' AND NEW."compositionId" IS DISTINCT FROM OLD."compositionId" THEN RAISE EXCEPTION 'MedicationRequest: a line cannot move to another note'; END IF;
    IF TG_OP <> 'DELETE' AND NEW."orderStatus" <> 'active' THEN RAISE EXCEPTION 'MedicationRequest: a line of a draft is active'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'MedicationRequest: the note version is % — lines change only in a draft (rule 3)', st; END IF;
  -- a signed note: only an inpatient order's state, once, by MEDICATION_ORDER; who and why for a stop
  IF OLD."kind" <> 'inpatient' THEN RAISE EXCEPTION 'MedicationRequest: the note version is % — lines change only in a draft (rule 3)', st; END IF;
  IF (to_jsonb(NEW) - ARRAY['orderStatus', 'stoppedAt', 'stoppedById', 'stopReason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['orderStatus', 'stoppedAt', 'stoppedById', 'stopReason']) THEN
    RAISE EXCEPTION 'MedicationRequest %: a signed order is never edited — stop it or amend the note', OLD."id";
  END IF;
  IF NEW."orderStatus" IS DISTINCT FROM OLD."orderStatus" AND (OLD."orderStatus" <> 'active' OR NEW."orderStatus" NOT IN ('stopped', 'superseded', 'completed')) THEN
    RAISE EXCEPTION 'MedicationRequest %: MEDICATION_ORDER cannot go from % to %', OLD."id", OLD."orderStatus", NEW."orderStatus";
  END IF;
  IF NEW."orderStatus" = 'stopped' AND OLD."orderStatus" = 'active' AND (NEW."stoppedAt" IS NULL OR char_length(btrim(coalesce(NEW."stopReason", ''))) < 5 OR NOT lab_actor_ok(NEW."stoppedById")) THEN
    RAISE EXCEPTION 'MedicationRequest %: a stop records who, when and why', OLD."id";
  END IF;
  IF NEW."orderStatus" <> 'stopped' AND (NEW."stoppedAt", NEW."stoppedById", NEW."stopReason") IS DISTINCT FROM (OLD."stoppedAt", OLD."stoppedById", OLD."stopReason") THEN
    RAISE EXCEPTION 'MedicationRequest %: the stop record is written only when stopping', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER medication_request_guard BEFORE INSERT OR UPDATE OR DELETE ON "MedicationRequest" FOR EACH ROW EXECUTE FUNCTION medication_request_guard();
-- a signed inpatient order has its start and its regimen
CREATE OR REPLACE FUNCTION composition_inpatient_signed() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('final', 'amended') AND EXISTS (SELECT 1 FROM "MedicationRequest" WHERE "compositionId" = NEW."id" AND "kind" = 'inpatient' AND ("startAt" IS NULL OR "regimenId" IS NULL)) THEN
    RAISE EXCEPTION 'Composition %: every inpatient order is signed with its start and regimen', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER composition_inpatient_signed AFTER UPDATE OF "status" ON "Composition" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composition_inpatient_signed();

-- ───── the MAR: an active order of this patient and this open inpatient visit; never in the future; one record per
--       slot; reasons; the five checks; the PRN cap over the regimen; a witness for high-alert drugs ─────
CREATE UNIQUE INDEX "MedicationAdministration_one_per_slot" ON "MedicationAdministration"("tenantId", "regimenId", "scheduledFor") WHERE "scheduledFor" IS NOT NULL AND "status" <> 'entered-in-error';
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT mar_shape CHECK (
  "source" IN ('ward-stock', 'patient-supplied') AND "timing" IN ('on-time', 'early', 'late', 'prn')
  AND ("status" <> 'given' OR ("checkPatient" AND "checkDrug" AND "checkDose" AND "checkRoute" AND "checkTime"))
  AND (("status" = 'given' AND "timing" IN ('on-time', 'prn')) OR char_length(btrim(coalesce("reason", ''))) >= 5)
  AND ("witnessedById" IS NULL OR ("witnessedById" <> "administeredById" AND "witnessedById" <> "preparedById" AND "witnessedAt" IS NOT NULL)));
REVOKE DELETE ON "MedicationAdministration", "MultiDoseVial", "EscalationEvent", "NursingNote", "WardIndent", "WardIndentLine", "WardIndentIssue", "ControlledDrugRegister" FROM setu_app;
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
  IF NEW."administeredAt" > now() + interval '2 minutes' THEN RAISE EXCEPTION 'MedicationAdministration: a dose is never recorded in the future'; END IF;
  IF NEW."administeredAt" < r."startAt" - interval '2 minutes' THEN RAISE EXCEPTION 'MedicationAdministration: before the order started'; END IF;
  IF r."prn" THEN
    IF NEW."scheduledFor" IS NOT NULL OR NEW."timing" <> 'prn' OR NEW."status" IN ('held', 'missed') THEN RAISE EXCEPTION 'MedicationAdministration: a PRN dose has no slot and is given or refused'; END IF;
    IF NEW."status" = 'given' THEN
      SELECT count(*) INTO given_n FROM "MedicationAdministration" WHERE "regimenId" = NEW."regimenId" AND "status" = 'given'
        AND "administeredAt" > NEW."administeredAt" - interval '24 hours' AND "administeredAt" <= NEW."administeredAt" + interval '24 hours';
      IF given_n + 1 > r."prnMaxPer24h" THEN RAISE EXCEPTION 'MedicationAdministration: PRN cap — % given in 24 hours, the order allows %', given_n, r."prnMaxPer24h"; END IF;
    END IF;
  ELSE
    IF NEW."scheduledFor" IS NULL OR NEW."timing" = 'prn' THEN RAISE EXCEPTION 'MedicationAdministration: a scheduled order''s dose is against its slot'; END IF;
    IF to_char(NEW."scheduledFor" AT TIME ZONE 'Asia/Dhaka', 'HH24:MI') <> ALL (r."times") OR NEW."scheduledFor" < r."startAt" OR date_part('second', NEW."scheduledFor") <> 0 THEN
      RAISE EXCEPTION 'MedicationAdministration: not a slot of the order';
    END IF;
    IF NEW."status" = 'missed' AND NEW."scheduledFor" + interval '60 minutes' > now() THEN RAISE EXCEPTION 'MedicationAdministration: missed only after the window has passed'; END IF;
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
CREATE TRIGGER medication_administration_guard BEFORE INSERT OR UPDATE OR DELETE ON "MedicationAdministration" FOR EACH ROW EXECUTE FUNCTION medication_administration_guard();

-- a multi-dose vial is opened for an active order of an open inpatient visit, by the signed-in nurse; never changed
CREATE OR REPLACE FUNCTION multi_dose_vial_guard() RETURNS trigger AS $$
DECLARE r RECORD; c RECORD; e RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'MultiDoseVial: an opened vial is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."openedById") OR NEW."openedAt" > now() + interval '2 minutes' OR NEW."source" NOT IN ('ward-stock', 'patient-supplied') THEN RAISE EXCEPTION 'MultiDoseVial: opened by the signed-in user, not in the future'; END IF;
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
CREATE TRIGGER multi_dose_vial_guard BEFORE INSERT OR UPDATE OR DELETE ON "MultiDoseVial" FOR EACH ROW EXECUTE FUNCTION multi_dose_vial_guard();

-- ───── the controlled-drug register: a controlled issue to a ward, dose or opened vial has its line at commit ─────
CREATE OR REPLACE FUNCTION controlled_register_required() RETURNS trigger AS $$
DECLARE b RECORD;
BEGIN
  IF NOT ((NEW."refType" = 'indent-issue' AND NEW."qty" < 0) OR NEW."refType" IN ('administration', 'vial-open')) THEN RETURN NULL; END IF;
  SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId";
  IF EXISTS (SELECT 1 FROM "Medicine" WHERE "tenantId" = NEW."tenantId" AND "key" = b."medicineKey" AND "controlled")
     AND NOT EXISTS (SELECT 1 FROM "ControlledDrugRegister" WHERE "stockMoveId" = NEW."id") THEN
    RAISE EXCEPTION 'StockMove %: a controlled drug moves with its register line', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER controlled_register_required AFTER INSERT ON "StockMove" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION controlled_register_required();
CREATE OR REPLACE FUNCTION controlled_register_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ControlledDrugRegister: a register line is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."byId") OR NEW."kind" NOT IN ('issue', 'administer', 'vial-open') OR NEW."balanceAfter" < 0 THEN RAISE EXCEPTION 'ControlledDrugRegister: by the signed-in user, a known kind, a balance'; END IF;
  IF NEW."kind" = 'administer' AND (NEW."witnessId" IS NULL OR NEW."witnessId" = NEW."byId") THEN RAISE EXCEPTION 'ControlledDrugRegister: a controlled dose is witnessed by someone else'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER controlled_register_guard BEFORE INSERT OR UPDATE OR DELETE ON "ControlledDrugRegister" FOR EACH ROW EXECUTE FUNCTION controlled_register_guard();

-- ───── escalations (ESCALATION): one open per visit; raised → doctor-informed (who, instruction) → resolved (note) ─────
CREATE UNIQUE INDEX "EscalationEvent_one_open" ON "EscalationEvent"("tenantId", "encounterId") WHERE "status" <> 'resolved';
CREATE OR REPLACE FUNCTION escalation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'EscalationEvent: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'raised' OR NEW."informedAt" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL OR NOT lab_actor_ok(NEW."raisedById") THEN RAISE EXCEPTION 'EscalationEvent: raised by the signed-in user'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."encounterId", NEW."patientId", NEW."observationId", NEW."raisedAt", NEW."raisedById", NEW."score", NEW."red")
     IS DISTINCT FROM (OLD."tenantId", OLD."encounterId", OLD."patientId", OLD."observationId", OLD."raisedAt", OLD."raisedById", OLD."score", OLD."red") THEN
    RAISE EXCEPTION 'EscalationEvent %: what raised it never changes', OLD."id";
  END IF;
  IF NEW."peakScore" < OLD."peakScore" THEN RAISE EXCEPTION 'EscalationEvent %: the peak only rises', OLD."id"; END IF;
  IF OLD."status" = 'resolved' THEN RAISE EXCEPTION 'EscalationEvent %: resolved is final', OLD."id"; END IF;
  IF NEW."status" = 'doctor-informed' AND OLD."status" = 'raised' AND (NEW."informedAt" IS NULL OR char_length(btrim(coalesce(NEW."spokeTo", ''))) < 3 OR char_length(btrim(coalesce(NEW."instruction", ''))) < 3 OR NOT lab_actor_ok(NEW."informedById")) THEN
    RAISE EXCEPTION 'EscalationEvent %: logged with whom, the instruction and who logged it', OLD."id";
  END IF;
  IF NEW."status" = 'resolved' AND (OLD."status" <> 'doctor-informed' OR NEW."resolvedAt" IS NULL OR char_length(btrim(coalesce(NEW."resolveNote", ''))) < 3 OR NOT lab_actor_ok(NEW."resolvedById")) THEN
    RAISE EXCEPTION 'EscalationEvent %: resolved after the doctor was informed, with a note', OLD."id";
  END IF;
  IF NEW."status" = 'raised' AND OLD."status" <> 'raised' THEN RAISE EXCEPTION 'EscalationEvent %: never back to raised', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER escalation_guard BEFORE INSERT OR UPDATE OR DELETE ON "EscalationEvent" FOR EACH ROW EXECUTE FUNCTION escalation_guard();

-- ───── nursing notes: append-only; only marked entered-in-error with a reason ─────
ALTER TABLE "NursingNote" ADD CONSTRAINT nursing_note_text CHECK (char_length(btrim("text")) >= 3 AND char_length("text") <= 4000);
CREATE OR REPLACE FUNCTION nursing_note_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'NursingNote: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active' OR NEW."errorAt" IS NOT NULL OR NOT lab_actor_ok(NEW."writtenById") OR NEW."effectiveAt" > now() + interval '2 minutes' THEN RAISE EXCEPTION 'NursingNote: written by the signed-in user, not in the future'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'active' OR NEW."status" <> 'entered-in-error'
     OR (to_jsonb(NEW) - ARRAY['status', 'errorReason', 'errorById', 'errorAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'errorReason', 'errorById', 'errorAt'])
     OR NEW."errorAt" IS NULL OR char_length(btrim(coalesce(NEW."errorReason", ''))) < 5 OR NOT lab_actor_ok(NEW."errorById") THEN
    RAISE EXCEPTION 'NursingNote %: a note is never edited — only marked entered-in-error with who, when and why', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER nursing_note_guard BEFORE INSERT OR UPDATE OR DELETE ON "NursingNote" FOR EACH ROW EXECUTE FUNCTION nursing_note_guard();

-- ───── indents (INDENT): issued only up to the request, only upwards; status by the machine ─────
ALTER TABLE "WardIndentLine" ADD CONSTRAINT ward_indent_line_qty CHECK ("qtyRequested" BETWEEN 1 AND 500 AND "qtyIssued" BETWEEN 0 AND "qtyRequested");
CREATE OR REPLACE FUNCTION ward_indent_line_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'WardIndentLine: never deleted'; END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'qtyIssued') IS DISTINCT FROM (to_jsonb(OLD) - 'qtyIssued') OR NEW."qtyIssued" < OLD."qtyIssued") THEN
    RAISE EXCEPTION 'WardIndentLine %: only the issued quantity moves, and only up', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ward_indent_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "WardIndentLine" FOR EACH ROW EXECUTE FUNCTION ward_indent_line_guard();
CREATE OR REPLACE FUNCTION ward_indent_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'WardIndent: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'requested' OR NOT lab_actor_ok(NEW."requestedById") THEN RAISE EXCEPTION 'WardIndent: requested by the signed-in user'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND (OLD."status"::text || '>' || NEW."status"::text) NOT IN (
    'requested>partially-issued', 'requested>issued', 'requested>cancelled', 'partially-issued>partially-issued', 'partially-issued>issued', 'partially-issued>cancelled') THEN
    RAISE EXCEPTION 'WardIndent %: INDENT cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF NEW."status" = 'cancelled' AND OLD."status" <> 'cancelled' AND (char_length(btrim(coalesce(NEW."cancelReason", ''))) < 5 OR NOT lab_actor_ok(NEW."cancelledById")) THEN
    RAISE EXCEPTION 'WardIndent %: cancelled with who and why', OLD."id";
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."wardId", NEW."number", NEW."requestedById", NEW."requestedAt") IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."wardId", OLD."number", OLD."requestedById", OLD."requestedAt") THEN
    RAISE EXCEPTION 'WardIndent %: what was requested never changes', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ward_indent_guard BEFORE INSERT OR UPDATE OR DELETE ON "WardIndent" FOR EACH ROW EXECUTE FUNCTION ward_indent_guard();
CREATE OR REPLACE FUNCTION ward_indent_issue_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'WardIndentIssue: an issue is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."byId") OR NEW."qty" < 1 THEN RAISE EXCEPTION 'WardIndentIssue: by the signed-in user, at least one unit'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ward_indent_issue_guard BEFORE INSERT OR UPDATE OR DELETE ON "WardIndentIssue" FOR EACH ROW EXECUTE FUNCTION ward_indent_issue_guard();
