-- Kamrul's decisions of 06/10/2026 (ADR 0015 amendment 2):
-- • escalation reach: an escalation no doctor acknowledges in the app within N minutes (facility setting, sample 15)
--   is raised to every doctor on duty (facility duty list, else every active doctor) and shown unacknowledged;
-- • a dose marked entered-in-error asks "was the stock drawn?": "no" returns the units to the ward batch they came
--   from (StockMove kind ward-return, refType dose-error, with the reason); a controlled register line is never changed
--   — a linked dose-error line notes the error and adds back what was returned.
ALTER TABLE "Organization" ADD COLUMN "escalationAckMinutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "Organization" ADD COLUMN "escalationDutyDoctorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Organization" ADD CONSTRAINT organization_escalation_ack CHECK ("escalationAckMinutes" BETWEEN 5 AND 120);
ALTER TABLE "EscalationEvent" ADD COLUMN "ackDueAt" TIMESTAMP(3);
ALTER TABLE "EscalationEvent" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
ALTER TABLE "EscalationEvent" ADD COLUMN "acknowledgedById" TEXT;
ALTER TABLE "EscalationEvent" ADD COLUMN "widenedAt" TIMESTAMP(3);
ALTER TABLE "EscalationEvent" DISABLE TRIGGER escalation_guard;
UPDATE "EscalationEvent" SET "ackDueAt" = "raisedAt" + interval '15 minutes';
ALTER TABLE "EscalationEvent" ENABLE TRIGGER escalation_guard;
CREATE INDEX "EscalationEvent_ack_sweep" ON "EscalationEvent"("ackDueAt") WHERE "status" <> 'resolved' AND "acknowledgedAt" IS NULL AND "widenedAt" IS NULL;
ALTER TABLE "MedicationAdministration" ADD COLUMN "errorStockDrawn" TEXT;
ALTER TABLE "ControlledDrugRegister" ADD COLUMN "note" TEXT;

ALTER TABLE "StockMove" DROP CONSTRAINT stock_move_shape;
ALTER TABLE "StockMove" ADD CONSTRAINT stock_move_shape CHECK (
  "qty" <> 0 AND "kind" IN ('receive', 'dispense', 'sale', 'adjust', 'return', 'transfer', 'administer', 'ward-return')
  AND ("kind" NOT IN ('dispense', 'sale', 'administer') OR "qty" < 0) AND ("kind" NOT IN ('receive', 'ward-return') OR "qty" > 0)
  AND ("kind" <> 'adjust' OR char_length(btrim(coalesce("reason", ''))) >= 10)
  AND ("kind" <> 'ward-return' OR char_length(btrim(coalesce("reason", ''))) >= 5));
ALTER TABLE "StockMove" DROP CONSTRAINT stock_move_ref_kinds;
ALTER TABLE "StockMove" ADD CONSTRAINT stock_move_ref_kinds CHECK (
  ("kind" <> 'receive' OR "refType" IN ('seed', 'grn-line'))
  AND ("kind" <> 'transfer' OR ("refType" IN ('transfer', 'indent-issue') AND "refId" IS NOT NULL))
  AND ("kind" <> 'administer' OR ("refType" IN ('administration', 'vial-open') AND "refId" IS NOT NULL))
  AND ("kind" <> 'ward-return' OR ("refType" = 'dose-error' AND "refId" IS NOT NULL)));

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
  IF OLD."peakRed" AND NOT NEW."peakRed" THEN RAISE EXCEPTION 'EscalationEvent %: a red parameter seen stays seen', OLD."id"; END IF;
  IF OLD."status" = 'resolved' THEN RAISE EXCEPTION 'EscalationEvent %: resolved is final', OLD."id"; END IF;
  -- the in-app acknowledgement and the widening to the doctors on duty are set once; they clear only when the patient
  -- is worse (the clock restarts) — a higher peak or a first red parameter
  IF ((OLD."acknowledgedAt" IS NOT NULL AND NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt")
      OR (OLD."widenedAt" IS NOT NULL AND NEW."widenedAt" IS DISTINCT FROM OLD."widenedAt")
      OR NEW."ackDueAt" IS DISTINCT FROM OLD."ackDueAt")
     AND NOT (NEW."peakScore" > OLD."peakScore" OR (NEW."peakRed" AND NOT OLD."peakRed")) THEN
    RAISE EXCEPTION 'EscalationEvent %: the acknowledgement clock changes only when the patient is worse', OLD."id";
  END IF;
  IF NEW."acknowledgedAt" IS NOT NULL AND OLD."acknowledgedAt" IS NULL THEN
    IF NEW."acknowledgedById" IS NULL OR NOT lab_actor_ok(NEW."acknowledgedById") OR NOT EXISTS (SELECT 1 FROM "PractitionerRole" pr WHERE pr."userId" = NEW."acknowledgedById" AND pr."organizationId" = NEW."organizationId" AND pr."role" = 'doctor') THEN
      RAISE EXCEPTION 'EscalationEvent %: acknowledged in the app by a doctor of this facility, signed in', OLD."id";
    END IF;
  END IF;
  IF NEW."status" = 'doctor-informed' AND OLD."status" = 'raised' AND (NEW."informedAt" IS NULL OR char_length(btrim(coalesce(NEW."spokeTo", ''))) < 3 OR char_length(btrim(coalesce(NEW."instruction", ''))) < 3 OR NOT lab_actor_ok(NEW."informedById")) THEN
    RAISE EXCEPTION 'EscalationEvent %: logged with whom, the instruction and who logged it', OLD."id";
  END IF;
  IF NEW."status" = 'resolved' AND (OLD."status" <> 'doctor-informed' OR NEW."resolvedAt" IS NULL OR char_length(btrim(coalesce(NEW."resolveNote", ''))) < 3 OR NOT lab_actor_ok(NEW."resolvedById")) THEN
    RAISE EXCEPTION 'EscalationEvent %: resolved after the doctor was informed, with a note', OLD."id";
  END IF;
  -- back to raised only when the patient is worse after the doctor was informed (a higher score, or a first red parameter)
  IF NEW."status" = 'raised' AND OLD."status" <> 'raised'
     AND NOT (OLD."status" = 'doctor-informed' AND (NEW."peakScore" > OLD."peakScore" OR (NEW."peakRed" AND NOT OLD."peakRed"))) THEN
    RAISE EXCEPTION 'EscalationEvent %: back to raised only when worse after the doctor was informed', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

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
  -- a multi-dose vial: the amount given is recorded, and from ward stock a vial of it is open for this patient
  IF NEW."status" = 'given' AND m."multiDose" THEN
    IF char_length(btrim(coalesce(NEW."amountGiven", ''))) = 0 THEN RAISE EXCEPTION 'MedicationAdministration: a multi-dose drug records the amount given'; END IF;
    IF NEW."source" = 'ward-stock' AND NOT EXISTS (SELECT 1 FROM "MultiDoseVial" v WHERE v."encounterId" = NEW."encounterId" AND v."medicineKey" = NEW."medicineKey" AND v."source" = 'ward-stock' AND v."openedAt" <= NEW."administeredAt" + interval '2 minutes') THEN
      RAISE EXCEPTION 'MedicationAdministration: no opened vial of this medicine for this patient';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION stock_move_backed() RETURNS trigger AS $$
DECLARE n int; total bigint; kinds int; bt RECORD; src RECORD; rs RECORD;
BEGIN
  IF current_user <> 'setu_app' THEN RETURN NULL; END IF;
  IF NEW."kind" = 'receive' THEN
    IF NOT EXISTS (SELECT 1 FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" g ON g."id" = l."receiptId"
                   WHERE NEW."refType" = 'grn-line' AND l."id" = NEW."refId" AND g."status" = 'posted' AND g."organizationId" = NEW."organizationId"
                     AND l."batchId" = NEW."batchId" AND l."receivedQty" = NEW."qty") THEN
      RAISE EXCEPTION 'StockMove %: a receive comes from a posted goods-receipt line', NEW."id";
    END IF;
  ELSIF NEW."kind" = 'transfer' THEN
    SELECT count(*), coalesce(sum(m."qty"), 0), count(DISTINCT (b."medicineKey", b."batchNo", b."expiry", b."costPaisa", b."mrpPaisa", b."vatRateBp"))
      INTO n, total, kinds FROM "StockMove" m JOIN "StockBatch" b ON b."id" = m."batchId" WHERE m."refType" = NEW."refType" AND m."refId" = NEW."refId";
    IF n <> 2 OR total <> 0 OR kinds <> 1 THEN RAISE EXCEPTION 'StockMove %: a transfer is two legs of the same batch that cancel out', NEW."id"; END IF;
    -- ADR 0015: an indent issue is backed by its issue row: from the store batch it names to that ward batch, the quantity it names
    IF NEW."refType" = 'indent-issue' AND NOT EXISTS (SELECT 1 FROM "WardIndentIssue" wi JOIN "StockBatch" f ON f."id" = wi."fromBatchId" JOIN "StockBatch" t ON t."id" = wi."toBatchId"
        WHERE wi."id" = NEW."refId" AND wi."qty" = abs(NEW."qty") AND f."location" = 'store' AND t."location" LIKE 'ward:%'
          AND ((NEW."qty" < 0 AND NEW."batchId" = wi."fromBatchId") OR (NEW."qty" > 0 AND NEW."batchId" = wi."toBatchId"))) THEN
      RAISE EXCEPTION 'StockMove %: an indent issue moves what its issue names, store to ward', NEW."id";
    END IF;
    SELECT * INTO bt FROM "StockBatch" WHERE "id" = NEW."batchId";
    IF bt."location" = 'quarantine' THEN
      SELECT * INTO rs FROM "StockResale" WHERE "transferRef" = NEW."refId";
      IF NEW."qty" > 0 OR NOT FOUND OR rs."fromBatchId" <> NEW."batchId" OR rs."qty" <> -NEW."qty" OR rs."organizationId" <> NEW."organizationId"
         OR NOT EXISTS (SELECT 1 FROM "StockMove" m JOIN "StockBatch" t ON t."id" = m."batchId" WHERE m."refType" = 'transfer' AND m."refId" = NEW."refId" AND m."batchId" = rs."toBatchId" AND t."location" = 'counter') THEN
        RAISE EXCEPTION 'StockMove %: returned stock leaves quarantine only for the counter, on a resale decision', NEW."id";
      END IF;
    END IF;
  ELSIF NEW."kind" = 'administer' THEN
    -- ADR 0015: out of a ward, for a dose given from ward stock or a multi-dose vial opened, of that medicine
    SELECT * INTO bt FROM "StockBatch" WHERE "id" = NEW."batchId";
    IF bt."location" NOT LIKE 'ward:%'
       OR NOT ((NEW."refType" = 'administration' AND EXISTS (SELECT 1 FROM "MedicationAdministration" x WHERE x."id" = NEW."refId" AND x."status" = 'given' AND x."source" = 'ward-stock' AND x."medicineKey" = bt."medicineKey" AND x."organizationId" = NEW."organizationId"))
            OR (NEW."refType" = 'vial-open' AND EXISTS (SELECT 1 FROM "MultiDoseVial" v WHERE v."id" = NEW."refId" AND v."source" = 'ward-stock' AND v."medicineKey" = bt."medicineKey" AND v."organizationId" = NEW."organizationId"))) THEN
      RAISE EXCEPTION 'StockMove %: ward stock goes out for a dose given from it or a vial opened', NEW."id";
    END IF;
  ELSIF NEW."kind" = 'ward-return' THEN
    -- a dose marked entered-in-error whose stock was not drawn: back to the ward batch it came from, never more than it took
    SELECT * INTO bt FROM "StockBatch" WHERE "id" = NEW."batchId";
    IF bt."location" NOT LIKE 'ward:%' OR NEW."refType" <> 'dose-error'
       OR NOT EXISTS (SELECT 1 FROM "MedicationAdministration" x WHERE x."id" = NEW."refId" AND x."status" = 'entered-in-error' AND x."errorStockDrawn" = 'no' AND x."source" = 'ward-stock' AND x."organizationId" = NEW."organizationId")
       OR (SELECT coalesce(sum(m."qty"), 0) FROM "StockMove" m WHERE m."refType" = 'dose-error' AND m."refId" = NEW."refId" AND m."batchId" = NEW."batchId")
          > (SELECT coalesce(-sum(m."qty"), 0) FROM "StockMove" m WHERE m."kind" = 'administer' AND m."refType" = 'administration' AND m."refId" = NEW."refId" AND m."batchId" = NEW."batchId") THEN
      RAISE EXCEPTION 'StockMove %: a ward return puts back what an errored dose took from that batch, no more', NEW."id";
    END IF;
  ELSIF NEW."kind" = 'adjust' THEN
    IF NOT EXISTS (SELECT 1 FROM "StockCount" c JOIN "StockCountLine" l ON l."countId" = c."id"
                   WHERE NEW."refType" = 'count' AND c."id" = NEW."refId" AND c."status" = 'approved' AND c."organizationId" = NEW."organizationId" AND l."batchId" = NEW."batchId") THEN
      RAISE EXCEPTION 'StockMove %: an adjustment comes from an approved count', NEW."id";
    END IF;
  ELSIF NEW."kind" = 'return' THEN
    SELECT * INTO bt FROM "StockBatch" WHERE "id" = NEW."batchId";
    SELECT sb.* INTO src FROM "RefundLine" l JOIN "Refund" x ON x."id" = l."refundId" JOIN "ChargeItem" ci ON ci."id" = l."chargeItemId" JOIN "StockBatch" sb ON sb."id" = ci."batchId"
      WHERE NEW."refType" = 'refund-line' AND l."id" = NEW."refId" AND l."units" = NEW."qty" AND x."status" IN ('approved', 'paid') AND x."organizationId" = NEW."organizationId";
    IF NOT FOUND OR bt."location" <> 'quarantine'
       OR (bt."medicineKey", bt."batchNo", bt."expiry", bt."costPaisa", bt."mrpPaisa", bt."vatRateBp") IS DISTINCT FROM (src."medicineKey", src."batchNo", src."expiry", src."costPaisa", src."mrpPaisa", src."vatRateBp") THEN
      RAISE EXCEPTION 'StockMove %: a return comes into quarantine from a refund line, the units it names', NEW."id";
    END IF;
    IF (SELECT count(*) FROM "StockMove" WHERE "refType" = 'refund-line' AND "refId" = NEW."refId") <> 1 THEN
      RAISE EXCEPTION 'StockMove %: a refund line''s medicine comes back once', NEW."id";
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION controlled_register_required() RETURNS trigger AS $$
DECLARE b RECORD;
BEGIN
  IF NOT ((NEW."refType" = 'indent-issue' AND NEW."qty" < 0) OR NEW."refType" IN ('administration', 'vial-open', 'dose-error')) THEN RETURN NULL; END IF;
  SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId";
  IF EXISTS (SELECT 1 FROM "Medicine" WHERE "tenantId" = NEW."tenantId" AND "key" = b."medicineKey" AND "controlled")
     AND NOT EXISTS (SELECT 1 FROM "ControlledDrugRegister" WHERE "stockMoveId" = NEW."id") THEN
    RAISE EXCEPTION 'StockMove %: a controlled drug moves with its register line', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION controlled_register_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ControlledDrugRegister: a register line is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."byId") OR NEW."kind" NOT IN ('issue', 'administer', 'vial-open', 'dose-error') OR NEW."balanceAfter" < 0 THEN RAISE EXCEPTION 'ControlledDrugRegister: by the signed-in user, a known kind, a balance'; END IF;
  IF NEW."kind" = 'dose-error' AND (NEW."administrationId" IS NULL OR NEW."qty" < 0 OR char_length(btrim(coalesce(NEW."note", ''))) < 5) THEN RAISE EXCEPTION 'ControlledDrugRegister: a dose-error line names the dose, the reason, and adds back only what was returned'; END IF;
  IF NEW."kind" = 'administer' AND (NEW."witnessId" IS NULL OR NEW."witnessId" = NEW."byId") THEN RAISE EXCEPTION 'ControlledDrugRegister: a controlled dose is witnessed by someone else'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- open escalations past their acknowledgement time, not yet widened, across tenants — ids only
CREATE OR REPLACE FUNCTION escalation_sweep_targets(p_now timestamptz)
RETURNS TABLE (tenant_id text, escalation_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e."tenantId", e."id" FROM "EscalationEvent" e
  WHERE e."status" <> 'resolved' AND e."acknowledgedAt" IS NULL AND e."widenedAt" IS NULL AND e."ackDueAt" <= p_now AT TIME ZONE 'UTC'
  ORDER BY e."ackDueAt" LIMIT 200;
$$;
REVOKE ALL ON FUNCTION escalation_sweep_targets(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION escalation_sweep_targets(timestamptz) TO setu_app;
