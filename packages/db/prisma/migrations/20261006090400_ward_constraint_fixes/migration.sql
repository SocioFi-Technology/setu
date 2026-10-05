-- ADR 0015 fixes found by the session 1 API tests:
-- • the ward's stock references: an indent issue is a two-leg transfer (refType indent-issue), a dose or an opened vial
--   takes stock out (administer moves with refType administration | vial-open);
-- • a dose marked entered-in-error keeps its original shape (an on-time given dose has no reason of its own);
-- • an admitted admission keeps its encounter, number and who admitted it; only its bed (a move) and its bill (opened
--   in the admission's own transaction) may be set afterwards — the "who" is checked when it becomes admitted.
ALTER TABLE "StockMove" DROP CONSTRAINT stock_move_ref_kinds;
ALTER TABLE "StockMove" ADD CONSTRAINT stock_move_ref_kinds CHECK (
  ("kind" <> 'receive' OR "refType" IN ('seed', 'grn-line'))
  AND ("kind" <> 'transfer' OR ("refType" IN ('transfer', 'indent-issue') AND "refId" IS NOT NULL))
  AND ("kind" <> 'administer' OR ("refType" IN ('administration', 'vial-open') AND "refId" IS NOT NULL)));

ALTER TABLE "MedicationAdministration" DROP CONSTRAINT mar_shape;
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT mar_shape CHECK (
  "source" IN ('ward-stock', 'patient-supplied') AND "timing" IN ('on-time', 'early', 'late', 'prn')
  AND ("status" <> 'given' OR ("checkPatient" AND "checkDrug" AND "checkDose" AND "checkRoute" AND "checkTime"))
  AND ("status" = 'entered-in-error' OR ("status" = 'given' AND "timing" IN ('on-time', 'prn')) OR char_length(btrim(coalesce("reason", ''))) >= 5)
  AND ("status" <> 'entered-in-error' OR char_length(btrim(coalesce("errorReason", ''))) >= 5)
  AND ("witnessedById" IS NULL OR ("witnessedById" <> "administeredById" AND "witnessedById" <> "preparedById" AND "witnessedAt" IS NOT NULL)));

CREATE OR REPLACE FUNCTION admission_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Admission %: never deleted', OLD."id"; END IF;
  IF NEW."source" NOT IN ('opd', 'er', 'direct') OR NEW."status" NOT IN ('requested', 'admitted', 'cancelled') THEN RAISE EXCEPTION 'Admission: unknown source or status'; END IF;
  IF TG_OP = 'INSERT' AND NOT lab_actor_ok(NEW."requestedById") THEN RAISE EXCEPTION 'Admission: requested by the signed-in user'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('admitted', 'cancelled') AND NEW."status" <> OLD."status" THEN RAISE EXCEPTION 'Admission %: % is final', OLD."id", OLD."status"; END IF;
  IF NEW."status" = 'admitted' AND (TG_OP = 'INSERT' OR OLD."status" <> 'admitted') AND (NEW."encounterId" IS NULL OR NEW."number" IS NULL OR NEW."admittedAt" IS NULL OR NOT lab_actor_ok(NEW."admittedById")) THEN
    RAISE EXCEPTION 'Admission %: admitted = encounter, number, time and who', NEW."id";
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'admitted' THEN
    IF (NEW."encounterId", NEW."number", NEW."admittedAt", NEW."admittedById", NEW."patientId", NEW."source") IS DISTINCT FROM (OLD."encounterId", OLD."number", OLD."admittedAt", OLD."admittedById", OLD."patientId", OLD."source") THEN
      RAISE EXCEPTION 'Admission %: what was admitted never changes', OLD."id";
    END IF;
    IF OLD."invoiceId" IS NOT NULL AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" THEN RAISE EXCEPTION 'Admission %: the IPD bill never changes', OLD."id"; END IF;
  END IF;
  IF NEW."status" <> 'admitted' AND (NEW."encounterId" IS NOT NULL OR NEW."invoiceId" IS NOT NULL) THEN RAISE EXCEPTION 'Admission %: only an admitted admission has an encounter and a bill', NEW."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
