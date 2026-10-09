-- ADR 0023 (E3): results back — the order's progress (collected, released with the centre's report, received by the
-- ordering doctor), the home collection fee fixed at the choice, and the person behind an ordering record (to link the
-- centre's record of them).
ALTER TABLE "PortableOrder" ADD COLUMN "homeFeePaisa" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PortableOrder" ADD COLUMN "collectedAt" TIMESTAMP(3);
ALTER TABLE "PortableOrder" ADD COLUMN "releasedAt" TIMESTAMP(3);
ALTER TABLE "PortableOrder" ADD COLUMN "resultReportId" TEXT;
ALTER TABLE "PortableOrder" ADD COLUMN "receivedAt" TIMESTAMP(3);
ALTER TABLE "PortableOrder" ADD COLUMN "receivedById" TEXT;
ALTER TABLE "PortableOrder" ADD CONSTRAINT portable_home_fee CHECK ("homeFeePaisa" >= 0);

CREATE OR REPLACE FUNCTION portable_order_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PortableOrder: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active' OR NEW."centreTenantId" IS NOT NULL THEN RAISE EXCEPTION 'PortableOrder: a new order waits for a centre'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."number", NEW."originTenantId", NEW."originOrganizationId", NEW."originPatientId", NEW."originEncounterId", NEW."orderedById", NEW."reorderOfId", NEW."createdAt",
      NEW."patientNameBn", NEW."patientNameEn", NEW."patientSex", NEW."patientAgeYears", NEW."patientPhone")
     IS DISTINCT FROM (OLD."number", OLD."originTenantId", OLD."originOrganizationId", OLD."originPatientId", OLD."originEncounterId", OLD."orderedById", OLD."reorderOfId", OLD."createdAt",
      OLD."patientNameBn", OLD."patientNameEn", OLD."patientSex", OLD."patientAgeYears", OLD."patientPhone") THEN
    RAISE EXCEPTION 'PortableOrder %: who ordered what for whom never changes', OLD."id";
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('active>centre-chosen', 'centre-chosen>accepted', 'centre-chosen>partially-accepted', 'centre-chosen>declined',
      'active>revoked', 'centre-chosen>revoked', 'accepted>accepted', 'partially-accepted>partially-accepted', 'declined>declined') THEN
    RAISE EXCEPTION 'PortableOrder %: ORDER cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF OLD."centreTenantId" IS NOT NULL AND (NEW."centreTenantId", NEW."centreOrganizationId", NEW."collection", NEW."chosenAt", NEW."chosenByKind", NEW."chosenBy")
     IS DISTINCT FROM (OLD."centreTenantId", OLD."centreOrganizationId", OLD."collection", OLD."chosenAt", OLD."chosenByKind", OLD."chosenBy") THEN
    RAISE EXCEPTION 'PortableOrder %: the chosen centre never changes (re-order elsewhere instead)', OLD."id";
  END IF;
  -- E3: the progress facts are set once, in order (collected → released → received); the released report may move to
  -- a later version of the same report
  IF (OLD."collectedAt" IS NOT NULL AND NEW."collectedAt" IS DISTINCT FROM OLD."collectedAt")
     OR (OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt")
     OR (OLD."receivedAt" IS NOT NULL AND NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt")
     OR (NEW."homeFeePaisa" IS DISTINCT FROM OLD."homeFeePaisa" AND OLD."centreTenantId" IS NOT NULL) THEN
    RAISE EXCEPTION 'PortableOrder %: a progress step, once recorded, never changes', OLD."id";
  END IF;
  IF (NEW."collectedAt" IS NOT NULL OR NEW."releasedAt" IS NOT NULL) AND NEW."status" NOT IN ('accepted', 'partially-accepted') THEN
    RAISE EXCEPTION 'PortableOrder %: only accepted tests are collected and released', OLD."id";
  END IF;
  IF (NEW."releasedAt" IS NOT NULL AND NEW."resultReportId" IS NULL) OR (NEW."receivedAt" IS NOT NULL AND NEW."releasedAt" IS NULL) THEN
    RAISE EXCEPTION 'PortableOrder %: released with its report; received after release', OLD."id";
  END IF;
  IF OLD."decidedAt" IS NOT NULL AND (NEW."decidedAt", NEW."decidedById", NEW."centrePatientId", NEW."centreEncounterId")
     IS DISTINCT FROM (OLD."decidedAt", OLD."decidedById", OLD."centrePatientId", OLD."centreEncounterId") THEN
    RAISE EXCEPTION 'PortableOrder %: the centre''s decision never changes', OLD."id";
  END IF;
  RETURN NEW;
END $function$;

-- the person linked to a record (SECURITY DEFINER: claims are per tenant) — one person only, else none
CREATE OR REPLACE FUNCTION person_of_record(p_tenant text, p_patient text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN count(DISTINCT c."personId") = 1 THEN min(c."personId") END
  FROM "PatientClaim" c WHERE c."tenantId" = p_tenant AND c."patientId" = p_patient AND c."status" = 'linked';
$$;
REVOKE ALL ON FUNCTION person_of_record(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_of_record(text, text) TO setu_app;
