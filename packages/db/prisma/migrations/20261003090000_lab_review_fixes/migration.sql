-- Slice A8–A11 session 2: fixes from the security and clinical-safety reviews (database side).
-- • clinical H1: a test whose released results were withdrawn (order complete, no current results) can get a new tube;
-- • clinical H2: a tube whose results are still current cannot be rejected (withdraw them first);
-- • security L1: every "who" column the API writes must be the signed-in user (app.user_id, set by forTenant);
-- • security L2: a lab result's flag matches its value against the stored critical limits; results only for a placed,
--   uncancelled order from a tube in process; • security L3: a version is superseded only by its own next version;
-- • security L6 / clinical: steps not before the step before them; a call-back not before the result was entered.

-- true when the row is written by the owner (migrations, seed, E2E reset) or by setu_app as the signed-in user
CREATE OR REPLACE FUNCTION lab_actor_ok(uid text) RETURNS boolean AS $$
  SELECT current_user <> 'setu_app' OR (uid IS NOT NULL AND uid = current_setting('app.user_id', true));
$$ LANGUAGE sql STABLE;

ALTER TABLE "Observation" ADD CONSTRAINT observation_lab_flag CHECK (
  "category" <> 'laboratory' OR (("interpretation" IS NOT NULL AND "interpretation" IN ('HH', 'LL')) =
    (("critLow" IS NOT NULL AND "value" < "critLow") OR ("critHigh" IS NOT NULL AND "value" > "critHigh"))));

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
    IF NOT lab_actor_ok(NEW."recordedById") THEN RAISE EXCEPTION 'Observation: a lab result is entered by the signed-in user'; END IF;
    IF current_user = 'setu_app' THEN
      -- security review L2: only for a placed order that is not cancelled, from a tube in process (a correction keeps
      -- the original tube, which may be done by then)
      IF EXISTS (SELECT 1 FROM "ServiceRequest" o WHERE o."id" = NEW."serviceRequestId" AND o."status" IN ('draft', 'revoked', 'declined')) THEN
        RAISE EXCEPTION 'Observation: the order is not placed or was cancelled'; END IF;
      IF NEW."replacesId" IS NULL AND NOT EXISTS (SELECT 1 FROM "Specimen" sp WHERE sp."id" = NEW."specimenId" AND sp."status" = 'in-process') THEN
        RAISE EXCEPTION 'Observation: results are entered from a tube in process'; END IF;
    END IF;
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
  -- security review L1: who verified / validated / withdrew / returned is the signed-in user
  IF (NEW."verifiedById" IS DISTINCT FROM OLD."verifiedById" AND NEW."verifiedById" IS NOT NULL AND NOT lab_actor_ok(NEW."verifiedById"))
     OR (NEW."validatedById" IS DISTINCT FROM OLD."validatedById" AND NOT lab_actor_ok(NEW."validatedById"))
     OR (NEW."errorById" IS DISTINCT FROM OLD."errorById" AND NOT lab_actor_ok(NEW."errorById"))
     OR (NEW."returnedById" IS DISTINCT FROM OLD."returnedById" AND NOT lab_actor_ok(NEW."returnedById")) THEN
    RAISE EXCEPTION 'Observation %: recorded in the name of someone other than the signed-in user', OLD."id"; END IF;
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
    IF NOT lab_actor_ok(NEW."labelPrintedById") THEN RAISE EXCEPTION 'Specimen: a label is printed by the signed-in user'; END IF;
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
  -- security review L1 / L6: each step is recorded by the signed-in user, and not before the step before it
  IF (NEW."collectedById" IS DISTINCT FROM OLD."collectedById" AND NOT lab_actor_ok(NEW."collectedById"))
     OR (NEW."receivedById" IS DISTINCT FROM OLD."receivedById" AND NOT lab_actor_ok(NEW."receivedById"))
     OR (NEW."startedById" IS DISTINCT FROM OLD."startedById" AND NOT lab_actor_ok(NEW."startedById"))
     OR (NEW."rejectedById" IS DISTINCT FROM OLD."rejectedById" AND NOT lab_actor_ok(NEW."rejectedById")) THEN
    RAISE EXCEPTION 'Specimen %: recorded in the name of someone other than the signed-in user', OLD."id"; END IF;
  IF (NEW."collectedAt" IS NOT NULL AND NEW."collectedAt" < NEW."labelPrintedAt" - interval '5 minutes')
     OR (NEW."receivedAt" IS NOT NULL AND NEW."receivedAt" < NEW."collectedAt" - interval '1 minute')
     OR (NEW."startedAt" IS NOT NULL AND NEW."startedAt" < NEW."receivedAt" - interval '1 minute') THEN
    RAISE EXCEPTION 'Specimen %: a step cannot happen before the step before it', OLD."id"; END IF;
  -- clinical review H2: a tube whose results are still current is not rejected (withdraw them first); a withdrawal
  -- rejects it after marking that test's results entered-in-error, and other tests on it keep theirs
  IF NEW."status" = 'rejected' AND NEW."rejectReason" IS DISTINCT FROM 'results-withdrawn'
     AND EXISTS (SELECT 1 FROM "Observation" x WHERE x."specimenId" = NEW."id" AND x."category" = 'laboratory' AND x."status" <> 'entered-in-error') THEN
    RAISE EXCEPTION 'Specimen %: results from this tube are still current — withdraw them first', OLD."id"; END IF;
  IF NEW."status" = 'rejected' THEN
    IF NEW."rejectedById" IS NULL OR NEW."rejectedAt" IS NULL
       OR NEW."rejectReason" NOT IN ('haemolysed', 'clotted', 'insufficient', 'label-mismatch', 'wrong-container', 'other', 'results-withdrawn')
       OR (NEW."rejectReason" = 'other' AND length(btrim(coalesce(NEW."rejectNote", ''))) < 10) THEN
      RAISE EXCEPTION 'Specimen %: a rejection needs who, when and a reason from the list (other: a note of at least 10 characters)', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION specimen_order_guard() RETURNS trigger AS $$
DECLARE sp RECORD; o RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'SpecimenOrder: the tests on a tube never change'; END IF;
  SELECT "status", "encounterId" INTO sp FROM "Specimen" WHERE "id" = NEW."specimenId";
  SELECT "status", "encounterId", "group" INTO o FROM "ServiceRequest" WHERE "id" = NEW."serviceRequestId";
  IF sp IS NULL OR o IS NULL OR sp."status" <> 'pending' OR sp."encounterId" <> o."encounterId" OR o."group" <> 'lab' OR o."status" IN ('draft', 'revoked', 'declined')
     -- clinical review H1: a released (complete) test whose results were withdrawn needs a new tube
     OR (o."status" = 'complete' AND EXISTS (SELECT 1 FROM "Observation" x WHERE x."serviceRequestId" = o."id" AND x."category" = 'laboratory' AND x."status" <> 'entered-in-error')) THEN
    RAISE EXCEPTION 'SpecimenOrder: a placed lab order of the same visit without current results, on a tube not yet collected';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION critical_callback_guard() RETURNS trigger AS $$
DECLARE o RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'CriticalCallback: a call-back record is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."callerId") THEN RAISE EXCEPTION 'CriticalCallback: logged by the signed-in user'; END IF;
  SELECT "category", "interpretation", "status", "patientId", "encounterId", "recordedAt" INTO o FROM "Observation" WHERE "id" = NEW."observationId";
  IF o IS NULL OR o."category" <> 'laboratory' OR o."interpretation" NOT IN ('HH', 'LL') OR o."status" NOT IN ('preliminary', 'verified')
     OR o."patientId" <> NEW."patientId" OR o."encounterId" <> NEW."encounterId" THEN
    RAISE EXCEPTION 'CriticalCallback: only for a critical (HH/LL) lab result of this patient that is not yet validated';
  END IF;
  IF NEW."calledAt" > now() + interval '5 minutes' THEN RAISE EXCEPTION 'CriticalCallback: the call time is in the future'; END IF;
  IF NEW."calledAt" < o."recordedAt" - interval '1 minute' THEN RAISE EXCEPTION 'CriticalCallback: the call cannot be before the result was entered'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION diagnostic_report_guard() RETURNS trigger AS $$
DECLARE prev RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DiagnosticReport %: a released report is never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'superseded' OR NEW."supersededById" IS NOT NULL THEN RAISE EXCEPTION 'DiagnosticReport: a new version is current'; END IF;
    IF NOT lab_actor_ok(NEW."releasedById") THEN RAISE EXCEPTION 'DiagnosticReport: released by the signed-in user'; END IF;
    IF NEW."replacesId" IS NOT NULL THEN
      SELECT "status", "supersededById", "encounterId", "version", "number" INTO prev FROM "DiagnosticReport" WHERE "id" = NEW."replacesId";
      IF prev IS NULL OR prev."status" <> 'superseded' OR prev."supersededById" IS DISTINCT FROM NEW."id" OR prev."encounterId" <> NEW."encounterId"
         OR prev."version" <> NEW."version" - 1 OR prev."number" <> NEW."number" THEN
        RAISE EXCEPTION 'DiagnosticReport: version % must replace the visit''s previous version, superseded by it', NEW."version";
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'superseded' OR NEW."status" <> 'superseded' OR NEW."supersededById" IS NULL
     OR (NEW."tenantId", NEW."organizationId", NEW."branchId", NEW."patientId", NEW."encounterId", NEW."number", NEW."version", NEW."testCount", NEW."pendingCount",
         NEW."replacesId", NEW."releasedById", NEW."releasedAt", NEW."createdAt")
        IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."branchId", OLD."patientId", OLD."encounterId", OLD."number", OLD."version", OLD."testCount", OLD."pendingCount",
         OLD."replacesId", OLD."releasedById", OLD."releasedAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'DiagnosticReport %: a released version only becomes superseded by the next one', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION service_request_guard() RETURNS trigger AS $$
DECLARE st "DocumentStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO st FROM "Composition" WHERE "id" = NEW."compositionId";
    IF st IS DISTINCT FROM 'draft' OR NEW."status" <> 'draft' THEN RAISE EXCEPTION 'ServiceRequest: new orders start as drafts of a draft note'; END IF;
    IF NEW."revokedById" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."revokeReason" IS NOT NULL THEN RAISE EXCEPTION 'ServiceRequest: a new order is not revoked'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'draft' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ServiceRequest %: a placed order is never deleted (revoke it)', OLD."id"; END IF;
    IF (NEW."testCode", NEW."nameEn", NEW."nameBn", NEW."group", NEW."priority", NEW."note", NEW."encounterId", NEW."patientId",
        NEW."compositionId", NEW."orderedById", NEW."orderedAt", NEW."tenantId", NEW."organizationId", NEW."branchId", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."testCode", OLD."nameEn", OLD."nameBn", OLD."group", OLD."priority", OLD."note", OLD."encounterId", OLD."patientId",
        OLD."compositionId", OLD."orderedById", OLD."orderedAt", OLD."tenantId", OLD."organizationId", OLD."branchId", OLD."createdAt") THEN
      RAISE EXCEPTION 'ServiceRequest %: a placed order is not edited', OLD."id";
    END IF;
    -- ORDER machine (@setu/domain machines.ts): only its transitions, never backwards.
    IF NEW."status" IS DISTINCT FROM OLD."status" AND (OLD."status"::text || '>' || NEW."status"::text) NOT IN (
      'active>centre-chosen', 'active>in-progress', 'active>revoked',
      'centre-chosen>accepted', 'centre-chosen>partially-accepted', 'centre-chosen>declined', 'centre-chosen>revoked',
      'accepted>in-progress', 'accepted>revoked', 'partially-accepted>in-progress', 'partially-accepted>revoked',
      'in-progress>partially-complete', 'in-progress>complete', 'partially-complete>complete') THEN
      RAISE EXCEPTION 'ServiceRequest %: ORDER cannot go from % to %', OLD."id", OLD."status", NEW."status";
    END IF;
    -- Revoking records who, when and why (≥10 characters), once; the record never changes afterwards.
    IF NEW."status" = 'revoked' AND OLD."status" <> 'revoked' THEN
      IF NEW."revokedById" IS NULL OR NEW."revokedAt" IS NULL OR length(btrim(coalesce(NEW."revokeReason", ''))) < 10 OR NOT lab_actor_ok(NEW."revokedById") THEN
        RAISE EXCEPTION 'ServiceRequest %: revoking needs who, when and a reason of at least 10 characters', OLD."id";
      END IF;
    ELSIF (NEW."revokedById", NEW."revokedAt", NEW."revokeReason") IS DISTINCT FROM (OLD."revokedById", OLD."revokedAt", OLD."revokeReason") THEN
      RAISE EXCEPTION 'ServiceRequest %: the revoke record is written only when revoking', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  SELECT "status" INTO st FROM "Composition" WHERE "id" = OLD."compositionId";
  IF st IS DISTINCT FROM 'draft' AND NOT (TG_OP = 'UPDATE' AND NEW."status" = 'active') THEN
    RAISE EXCEPTION 'ServiceRequest %: a draft order of a signed note cannot change', OLD."id";
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."status" NOT IN ('draft', 'active') THEN RAISE EXCEPTION 'ServiceRequest %: a draft order is placed (active) before anything else', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- security review L3: a version marked superseded must be replaced, in the same transaction, by its own next version
CREATE OR REPLACE FUNCTION diagnostic_report_superseded_check() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'superseded' AND NOT EXISTS (
       SELECT 1 FROM "DiagnosticReport" r WHERE r."id" = NEW."supersededById" AND r."replacesId" = NEW."id" AND r."encounterId" = NEW."encounterId") THEN
    RAISE EXCEPTION 'DiagnosticReport %: superseded without its next version', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER diagnostic_report_superseded_check AFTER UPDATE ON "DiagnosticReport" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION diagnostic_report_superseded_check();
