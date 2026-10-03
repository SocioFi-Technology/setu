-- Admin session 1 review fixes (ADR 0010): the signer's registration kept on the signed note, audit events per facility, a one-time password works once.
-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Composition" ADD COLUMN     "signerRegBody" TEXT,
ADD COLUMN     "signerRegNo" TEXT,
ADD COLUMN     "signerRegVerified" BOOLEAN;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tempPasswordUsedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_organizationId_at_idx" ON "AuditEvent"("tenantId", "organizationId", "at");


-- ───── a signed note keeps its signer's registration as it was then ─────
-- The guard fills the copy when a draft is signed (no signing path can forget it) and freezes it with the rest.
CREATE OR REPLACE FUNCTION composition_guard() RETURNS trigger AS $$
DECLARE pr RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Composition is never deleted (rule 3)'; END IF;
  IF OLD."status" = 'draft' THEN
    IF NEW."status" IN ('final', 'amended') AND NEW."signedById" IS NOT NULL THEN
      SELECT "regBody", "regNo", "regVerified" INTO pr FROM "Practitioner" WHERE "userId" = NEW."signedById";
      NEW."signerRegBody" := pr."regBody"; NEW."signerRegNo" := pr."regNo"; NEW."signerRegVerified" := coalesce(pr."regVerified", false);
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (OLD."status" IN ('final', 'amended') AND NEW."status" IN ('superseded', 'entered-in-error')) THEN
    RAISE EXCEPTION 'Composition %: a signed version cannot change from % to % (rule 3)', OLD."id", OLD."status", NEW."status";
  END IF;
  IF (NEW."sections", NEW."sectionSources", NEW."version", NEW."encounterId", NEW."patientId", NEW."tenantId", NEW."kind",
      NEW."amendsId", NEW."amendReason", NEW."authorId", NEW."signedAt", NEW."signedById", NEW."aiReviewed", NEW."rev",
      NEW."uncodedAllergiesChecked", NEW."organizationId", NEW."branchId", NEW."createdAt",
      NEW."signerRegBody", NEW."signerRegNo", NEW."signerRegVerified")
     IS DISTINCT FROM
     (OLD."sections", OLD."sectionSources", OLD."version", OLD."encounterId", OLD."patientId", OLD."tenantId", OLD."kind",
      OLD."amendsId", OLD."amendReason", OLD."authorId", OLD."signedAt", OLD."signedById", OLD."aiReviewed", OLD."rev",
      OLD."uncodedAllergiesChecked", OLD."organizationId", OLD."branchId", OLD."createdAt",
      OLD."signerRegBody", OLD."signerRegNo", OLD."signerRegVerified") THEN
    RAISE EXCEPTION 'Composition %: a signed version is never edited — amend it (rule 3)', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- notes signed before this migration: the registration as it stands now (the best record there is)
ALTER TABLE "Composition" DISABLE TRIGGER composition_guard;
UPDATE "Composition" c SET "signerRegBody" = pr."regBody", "signerRegNo" = pr."regNo", "signerRegVerified" = coalesce(pr."regVerified", false)
  FROM "Practitioner" pr WHERE pr."userId" = c."signedById" AND c."status" <> 'draft' AND c."signerRegVerified" IS NULL;
ALTER TABLE "Composition" ENABLE TRIGGER composition_guard;

-- the public prescription check shows the registration as signed
CREATE OR REPLACE FUNCTION rx_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenantId', c."tenantId", 'patientId', c."patientId", 'documentId', c."id",
    'facilityEn', o."name", 'facilityBn', o."nameBn",
    'doctorEn', u."nameEn", 'doctorBn', u."nameBn", 'regBody', c."signerRegBody", 'regNo', c."signerRegNo", 'regVerified', COALESCE(c."signerRegVerified", false),
    'signedAt', c."signedAt", 'version', c."version", 'status', c."status",
    'initials', person_initials(p."nameEn", p."nameBn"), 'sex', p."sex",
    'birthDate', to_char(p."birthDate", 'YYYY-MM-DD'), 'approxAgeYears', p."approxAgeYears", 'approxAgeAt', p."approxAgeAt",
    'medicines', COALESCE((SELECT jsonb_agg(jsonb_build_object('brand', m."brand", 'generic', m."generic", 'strength', m."strength", 'form', m."form",
                                  'dose', m."dose", 'meal', m."meal", 'days', m."days", 'quantity', m."quantity", 'note', m."note", 'sample', m."sample") ORDER BY m."position")
                           FROM "MedicationRequest" m WHERE m."compositionId" = c."id" AND m."tenantId" = c."tenantId"), '[]'::jsonb))
  FROM "DocumentCode" d
  JOIN "Composition" c ON c."id" = d."documentId" AND c."tenantId" = d."tenantId"
  JOIN "Organization" o ON o."id" = c."organizationId"
  JOIN "Patient" p ON p."id" = c."patientId"
  LEFT JOIN "User" u ON u."id" = c."signedById"
  WHERE d."verifyCode" = p_code AND d."kind" = 'rx'
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION rx_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rx_verify_lookup(text) TO setu_app;

-- ───── audit events per facility ─────
-- earlier events: the facility of the person who did them, when they work at exactly one (the append-only trigger is
-- paused for this one backfill only, inside this migration)
ALTER TABLE "AuditEvent" DISABLE TRIGGER USER;
UPDATE "AuditEvent" a SET "organizationId" = r."organizationId"
  FROM (SELECT "userId", min("organizationId") AS "organizationId" FROM "PractitionerRole" GROUP BY "userId" HAVING count(DISTINCT "organizationId") = 1) r
  WHERE a."userId" = r."userId" AND a."organizationId" IS NULL;
ALTER TABLE "AuditEvent" ENABLE TRIGGER USER;
