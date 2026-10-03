-- Slice A8–A11 session 2 (ADR 0006 addendum, Kamrul's decisions 119 and 133).
-- Send-back: RESULT verified → preliminary with who / when / why (≥10), the verification cleared. Withdraw results:
-- the tube a test was measured in may be rejected from `done`, only with the reason results-withdrawn.

-- AlterTable
ALTER TABLE "Observation" ADD COLUMN     "returnReason" TEXT,
ADD COLUMN     "returnedAt" TIMESTAMP(3),
ADD COLUMN     "returnedById" TEXT;

GRANT UPDATE ("returnedById", "returnedAt", "returnReason") ON "Observation" TO setu_app;

CREATE OR REPLACE FUNCTION observation_guard() RETURNS trigger AS $$
DECLARE prev RECORD; allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."category" = 'laboratory' THEN RAISE EXCEPTION 'Observation %: a lab result is never deleted', OLD."id"; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."category" <> 'laboratory' THEN RETURN NEW; END IF;
    IF NEW."status" <> 'preliminary' OR NEW."verifiedById" IS NOT NULL OR NEW."validatedById" IS NOT NULL OR NEW."errorById" IS NOT NULL OR NEW."returnedById" IS NOT NULL THEN
      RAISE EXCEPTION 'Observation: a lab result is entered as preliminary';
    END IF;
    IF NEW."serviceRequestId" IS NULL AND current_user = 'setu_app' THEN RAISE EXCEPTION 'Observation: a lab result belongs to an order'; END IF;
    IF NEW."replacesId" IS NOT NULL THEN
      SELECT "status", "patientId", "code", "serviceRequestId", "category" INTO prev FROM "Observation" WHERE "id" = NEW."replacesId";
      IF prev IS NULL OR prev."category" <> 'laboratory' OR prev."status" <> 'entered-in-error' OR prev."patientId" <> NEW."patientId" OR prev."code" <> NEW."code"
         OR prev."serviceRequestId" IS DISTINCT FROM NEW."serviceRequestId" THEN
        RAISE EXCEPTION 'Observation: a correction replaces an entered-in-error result of the same test and analyte';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."category" <> 'laboratory' THEN
    IF current_user = 'setu_app' THEN RAISE EXCEPTION 'Observation %: vital signs are append-only', OLD."id"; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."branchId", NEW."patientId", NEW."encounterId", NEW."batchId", NEW."category", NEW."code", NEW."value", NEW."unit",
      NEW."method", NEW."interpretation", NEW."recordedById", NEW."effectiveAt", NEW."recordedAt", NEW."deviceLabel", NEW."serviceRequestId", NEW."specimenId",
      NEW."refLow", NEW."refHigh", NEW."refLabel", NEW."critLow", NEW."critHigh", NEW."deltaPrevId", NEW."deltaPct", NEW."replacesId")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."organizationId", OLD."branchId", OLD."patientId", OLD."encounterId", OLD."batchId", OLD."category", OLD."code", OLD."value", OLD."unit",
      OLD."method", OLD."interpretation", OLD."recordedById", OLD."effectiveAt", OLD."recordedAt", OLD."deviceLabel", OLD."serviceRequestId", OLD."specimenId",
      OLD."refLow", OLD."refHigh", OLD."refLabel", OLD."critLow", OLD."critHigh", OLD."deltaPrevId", OLD."deltaPct", OLD."replacesId") THEN
    RAISE EXCEPTION 'Observation %: a lab result is never changed (correct it: a new version)', OLD."id";
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('preliminary>verified', 'verified>final', 'verified>preliminary', 'final>amended', 'amended>amended',
       'preliminary>entered-in-error', 'verified>entered-in-error', 'final>entered-in-error', 'amended>entered-in-error') THEN
    RAISE EXCEPTION 'Observation %: RESULT cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  -- who/when are written by their own step only, and never change afterwards
  IF (NEW."verifiedById", NEW."verifiedAt") IS DISTINCT FROM (OLD."verifiedById", OLD."verifiedAt")
     AND NOT (OLD."status" = 'preliminary' AND NEW."status" = 'verified')
     AND NOT (OLD."status" = 'verified' AND NEW."status" = 'preliminary' AND NEW."verifiedById" IS NULL AND NEW."verifiedAt" IS NULL) THEN
    RAISE EXCEPTION 'Observation %: verification is recorded only by verifying (and cleared only by a send-back)', OLD."id"; END IF;
  -- send-back (decision 119): who, when and why, written only by returning a verified result
  IF (NEW."returnedById", NEW."returnedAt", NEW."returnReason") IS DISTINCT FROM (OLD."returnedById", OLD."returnedAt", OLD."returnReason")
     AND NOT (OLD."status" = 'verified' AND NEW."status" = 'preliminary') THEN
    RAISE EXCEPTION 'Observation %: a send-back is recorded only by returning a verified result', OLD."id"; END IF;
  IF OLD."status" = 'verified' AND NEW."status" = 'preliminary'
     AND (NEW."verifiedById" IS NOT NULL OR NEW."returnedById" IS NULL OR NEW."returnedAt" IS NULL OR length(btrim(coalesce(NEW."returnReason", ''))) < 10) THEN
    RAISE EXCEPTION 'Observation %: a send-back clears the verification and records who, when and a reason of at least 10 characters', OLD."id"; END IF;
  IF (NEW."validatedById", NEW."validatedAt") IS DISTINCT FROM (OLD."validatedById", OLD."validatedAt") AND NOT (OLD."status" = 'verified' AND NEW."status" = 'final') THEN
    RAISE EXCEPTION 'Observation %: validation is recorded only by validating', OLD."id"; END IF;
  IF (NEW."errorReason", NEW."errorById", NEW."errorAt") IS DISTINCT FROM (OLD."errorReason", OLD."errorById", OLD."errorAt") AND NEW."status" <> 'entered-in-error' THEN
    RAISE EXCEPTION 'Observation %: an error record is written only when marking entered-in-error', OLD."id"; END IF;
  IF NEW."status" = 'verified' AND (NEW."verifiedById" IS NULL OR NEW."verifiedAt" IS NULL) THEN RAISE EXCEPTION 'Observation %: verified needs who and when', OLD."id"; END IF;
  IF NEW."status" = 'final' AND OLD."status" = 'verified' THEN
    IF NEW."validatedById" IS NULL OR NEW."validatedAt" IS NULL THEN RAISE EXCEPTION 'Observation %: validated needs who and when', OLD."id"; END IF;
    -- the same person may not verify and validate unless the facility (or the Clinic plan) allows it
    SELECT coalesce(o."labSamePersonAllowed", t."plan" = 'clinic') INTO allowed FROM "Organization" o JOIN "Tenant" t ON t."id" = o."tenantId" WHERE o."id" = NEW."organizationId";
    IF NEW."validatedById" = NEW."verifiedById" AND NOT coalesce(allowed, false) THEN
      RAISE EXCEPTION 'Observation %: the person who verified a result may not also validate it here', OLD."id"; END IF;
    -- a critical result needs a call-back that reached someone, with the value read back, for this exact result
    IF NEW."interpretation" IN ('HH', 'LL') AND NOT EXISTS (
         SELECT 1 FROM "CriticalCallback" c WHERE c."observationId" = NEW."id" AND c."outcome" = 'reached' AND c."readBack") THEN
      RAISE EXCEPTION 'Observation %: a critical result is validated only after its call-back is logged', OLD."id"; END IF;
  END IF;
  IF NEW."status" = 'entered-in-error' AND (NEW."errorById" IS NULL OR NEW."errorAt" IS NULL OR length(btrim(coalesce(NEW."errorReason", ''))) < 10) THEN
    RAISE EXCEPTION 'Observation %: entered-in-error needs who, when and a reason of at least 10 characters', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION specimen_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Specimen %: a tube is never deleted (reject it)', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' OR NEW."labelPrints" <> 1 OR NEW."collectedAt" IS NOT NULL OR NEW."receivedAt" IS NOT NULL OR NEW."startedAt" IS NOT NULL
       OR NEW."doneAt" IS NOT NULL OR NEW."rejectedAt" IS NOT NULL OR NEW."rejectReason" IS NOT NULL THEN
      RAISE EXCEPTION 'Specimen: a new tube starts as a printed label (pending)';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."branchId", NEW."patientId", NEW."encounterId", NEW."number", NEW."tube", NEW."labelPrintedById", NEW."labelPrintedAt", NEW."createdAt")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."branchId", OLD."patientId", OLD."encounterId", OLD."number", OLD."tube", OLD."labelPrintedById", OLD."labelPrintedAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'Specimen %: a tube''s identity never changes', OLD."id";
  END IF;
  -- who/when of each step: written once, never changed
  IF (OLD."collectedById" IS NOT NULL AND (NEW."collectedById", NEW."collectedAt") IS DISTINCT FROM (OLD."collectedById", OLD."collectedAt"))
     OR (OLD."receivedById" IS NOT NULL AND (NEW."receivedById", NEW."receivedAt") IS DISTINCT FROM (OLD."receivedById", OLD."receivedAt"))
     OR (OLD."startedById" IS NOT NULL AND (NEW."startedById", NEW."startedAt") IS DISTINCT FROM (OLD."startedById", OLD."startedAt"))
     OR (OLD."doneAt" IS NOT NULL AND NEW."doneAt" IS DISTINCT FROM OLD."doneAt")
     OR (OLD."rejectedById" IS NOT NULL AND (NEW."rejectedById", NEW."rejectedAt", NEW."rejectReason", NEW."rejectNote") IS DISTINCT FROM (OLD."rejectedById", OLD."rejectedAt", OLD."rejectReason", OLD."rejectNote")) THEN
    RAISE EXCEPTION 'Specimen %: a recorded step is never changed', OLD."id";
  END IF;
  IF NEW."status" = OLD."status" THEN
    -- the only same-state change: reprinting the label of a tube not yet collected
    IF OLD."status" <> 'pending' OR NEW."labelPrints" <> OLD."labelPrints" + 1 THEN RAISE EXCEPTION 'Specimen %: nothing to change', OLD."id"; END IF;
    RETURN NEW;
  END IF;
  IF NEW."labelPrints" <> OLD."labelPrints" THEN RAISE EXCEPTION 'Specimen %: a label is reprinted only before collection', OLD."id"; END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('pending>collected', 'pending>rejected', 'collected>received', 'collected>rejected',
       'received>in-process', 'received>rejected', 'in-process>done', 'in-process>rejected', 'done>rejected') THEN
    RAISE EXCEPTION 'Specimen %: SPECIMEN cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF (NEW."status" = 'collected' AND (NEW."collectedById" IS NULL OR NEW."collectedAt" IS NULL))
     OR (NEW."status" = 'received' AND (NEW."receivedById" IS NULL OR NEW."receivedAt" IS NULL))
     OR (NEW."status" = 'in-process' AND (NEW."startedById" IS NULL OR NEW."startedAt" IS NULL))
     OR (NEW."status" = 'done' AND NEW."doneAt" IS NULL) THEN
    RAISE EXCEPTION 'Specimen %: % needs who and when', OLD."id", NEW."status";
  END IF;
  IF OLD."status" = 'done' AND NEW."rejectReason" IS DISTINCT FROM 'results-withdrawn' THEN
    RAISE EXCEPTION 'Specimen %: a finished tube is rejected only when its results are withdrawn', OLD."id";
  END IF;
  IF NEW."status" = 'rejected' THEN
    IF NEW."rejectedById" IS NULL OR NEW."rejectedAt" IS NULL
       OR NEW."rejectReason" NOT IN ('haemolysed', 'clotted', 'insufficient', 'label-mismatch', 'wrong-container', 'other', 'results-withdrawn')
       OR (NEW."rejectReason" = 'other' AND length(btrim(coalesce(NEW."rejectNote", ''))) < 10) THEN
      RAISE EXCEPTION 'Specimen %: a rejection needs who, when and a reason from the list (other: a note of at least 10 characters)', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
