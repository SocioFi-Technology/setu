-- Slice A12–A13 session 1 (ADR 0007): the doctor's inbox acknowledgement, printed clinical documents and their
-- public verify lookups. Tables from `prisma migrate diff`; guards below.

-- CreateTable
CREATE TABLE "InboxAck" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "ackedById" TEXT NOT NULL,
    "ackedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifyPatient" BOOLEAN NOT NULL DEFAULT false,
    "notifyCommunicationId" TEXT,

    CONSTRAINT "InboxAck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "verifyCode" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPrint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "copy" INTEGER NOT NULL,
    "reason" TEXT,
    "format" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "printedById" TEXT NOT NULL,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentPrint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxAck_communicationId_key" ON "InboxAck"("communicationId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxAck_notifyCommunicationId_key" ON "InboxAck"("notifyCommunicationId");

-- CreateIndex
CREATE INDEX "InboxAck_tenantId_ackedById_idx" ON "InboxAck"("tenantId", "ackedById");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentCode_verifyCode_key" ON "DocumentCode"("verifyCode");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentCode_tenantId_kind_documentId_key" ON "DocumentCode"("tenantId", "kind", "documentId");

-- CreateIndex
CREATE INDEX "DocumentPrint_tenantId_codeId_idx" ON "DocumentPrint"("tenantId", "codeId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPrint_codeId_copy_key" ON "DocumentPrint"("codeId", "copy");

-- AddForeignKey
ALTER TABLE "InboxAck" ADD CONSTRAINT "InboxAck_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "Communication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPrint" ADD CONSTRAINT "DocumentPrint_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "DocumentCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security for the new tables (same loop as rls.sql; idempotent for the existing ones).
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

-- ───── append-only for every role: an acknowledgement, a verify code and a print are never changed or deleted ─────
REVOKE UPDATE, DELETE ON "InboxAck", "DocumentCode", "DocumentPrint" FROM setu_app;
CREATE OR REPLACE FUNCTION printed_record_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: this record is never changed or deleted', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER inbox_ack_immutable BEFORE UPDATE OR DELETE ON "InboxAck" FOR EACH ROW EXECUTE FUNCTION printed_record_immutable();
CREATE TRIGGER document_code_immutable BEFORE UPDATE OR DELETE ON "DocumentCode" FOR EACH ROW EXECUTE FUNCTION printed_record_immutable();
CREATE TRIGGER document_print_immutable BEFORE UPDATE OR DELETE ON "DocumentPrint" FOR EACH ROW EXECUTE FUNCTION printed_record_immutable();

-- ───── InboxAck: only the item's recipient, as the signed-in user; not a superseded report; "tell patient" = one
--       report-reviewed SMS to the same patient, only for a released report ─────
ALTER TABLE "InboxAck" ADD CONSTRAINT inbox_ack_notify CHECK ("notifyPatient" = ("notifyCommunicationId" IS NOT NULL));
CREATE OR REPLACE FUNCTION inbox_ack_guard() RETURNS trigger AS $$
DECLARE item RECORD; sms RECORD; superseded boolean;
BEGIN
  IF NOT lab_actor_ok(NEW."ackedById") THEN RAISE EXCEPTION 'InboxAck: acknowledged by someone other than the signed-in user'; END IF;
  IF NEW."ackedAt" > now() + interval '5 minutes' THEN RAISE EXCEPTION 'InboxAck: the time is in the future'; END IF;
  SELECT * INTO item FROM "Communication" WHERE "id" = NEW."communicationId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'InboxAck: no such inbox item'; END IF;
  IF item."channel" <> 'doctor-inbox' OR item."recipientUserId" IS DISTINCT FROM NEW."ackedById" THEN
    RAISE EXCEPTION 'InboxAck: only the doctor the item was sent to acknowledges it';
  END IF;
  IF item."kind" = 'report-inbox' THEN
    SELECT r."supersededById" IS NOT NULL INTO superseded FROM "DiagnosticReport" r WHERE r."id" = item."reportId" AND r."tenantId" = NEW."tenantId";
    IF superseded THEN RAISE EXCEPTION 'InboxAck: a newer version of this report exists'; END IF;
  END IF;
  IF NEW."notifyPatient" THEN
    IF item."kind" <> 'report-inbox' THEN RAISE EXCEPTION 'InboxAck: only a released report tells the patient'; END IF;
    SELECT * INTO sms FROM "Communication" WHERE "id" = NEW."notifyCommunicationId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND OR sms."channel" <> 'sms' OR sms."kind" <> 'report-reviewed' OR sms."patientId" <> item."patientId" THEN
      RAISE EXCEPTION 'InboxAck: the patient message must be the report-reviewed SMS to the same patient';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER inbox_ack_guard BEFORE INSERT ON "InboxAck" FOR EACH ROW EXECUTE FUNCTION inbox_ack_guard();

-- ───── DocumentCode / DocumentPrint: only a printable version (rx: signed final/amended note; lr: a current
--       released report), in the same facility; copies numbered 0, 1, 2 … with a reason after the original ─────
ALTER TABLE "DocumentCode" ADD CONSTRAINT document_code_shape CHECK (
  "kind" IN ('rx', 'lr') AND "verifyCode" ~ '^[0-9A-HJKMNP-TV-Z]{16,}$');
ALTER TABLE "DocumentPrint" ADD CONSTRAINT document_print_shape CHECK (
  "copy" >= 0 AND "format" IN ('a5', 'a4') AND "lang" IN ('both', 'bn', 'en')
  AND (("copy" = 0) = ("reason" IS NULL)) AND ("reason" IS NULL OR "reason" IN ('lost', 'jam', 'copy')));

-- true when document `doc` of kind rx|lr in that tenant and facility may be printed now
CREATE OR REPLACE FUNCTION document_printable(k text, doc text, tenant text, org text) RETURNS boolean AS $$
  SELECT CASE k
    WHEN 'rx' THEN EXISTS (SELECT 1 FROM "Composition" c WHERE c."id" = doc AND c."tenantId" = tenant AND c."organizationId" = org
                             AND c."kind" = 'consultation-note' AND c."status" IN ('final', 'amended'))
    WHEN 'lr' THEN EXISTS (SELECT 1 FROM "DiagnosticReport" r WHERE r."id" = doc AND r."tenantId" = tenant AND r."organizationId" = org
                             AND r."supersededById" IS NULL)
    ELSE false END;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION document_code_guard() RETURNS trigger AS $$
BEGIN
  IF NOT lab_actor_ok(NEW."createdById") THEN RAISE EXCEPTION 'DocumentCode: created by someone other than the signed-in user'; END IF;
  IF NOT document_printable(NEW."kind", NEW."documentId", NEW."tenantId", NEW."organizationId") THEN
    RAISE EXCEPTION 'DocumentCode: % % is not a printable version (drafts cannot be printed — sign first)', NEW."kind", NEW."documentId";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER document_code_guard BEFORE INSERT ON "DocumentCode" FOR EACH ROW EXECUTE FUNCTION document_code_guard();

CREATE OR REPLACE FUNCTION document_print_guard() RETURNS trigger AS $$
DECLARE c RECORD; n int;
BEGIN
  IF NOT lab_actor_ok(NEW."printedById") THEN RAISE EXCEPTION 'DocumentPrint: printed by someone other than the signed-in user'; END IF;
  SELECT * INTO c FROM "DocumentCode" WHERE "id" = NEW."codeId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'DocumentPrint: no such document code'; END IF;
  IF NOT document_printable(c."kind", c."documentId", c."tenantId", c."organizationId") THEN
    RAISE EXCEPTION 'DocumentPrint: this version can no longer be printed (a newer version exists or it was withdrawn)';
  END IF;
  SELECT count(*) INTO n FROM "DocumentPrint" WHERE "codeId" = NEW."codeId";
  IF NEW."copy" <> n THEN RAISE EXCEPTION 'DocumentPrint: copy % out of order (expected %)', NEW."copy", n; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER document_print_guard BEFORE INSERT ON "DocumentPrint" FOR EACH ROW EXECUTE FUNCTION document_print_guard();

-- ───── public verify lookups (no session): only what decision D2 allows; the patient as initials, sex and the
--       fields the API turns into an age (the date of birth never leaves the API) ─────
CREATE OR REPLACE FUNCTION person_initials(en text, bn text) RETURNS text AS $$
  SELECT COALESCE((SELECT string_agg(upper(left(w, 1)) || '.', ' ' ORDER BY i)
                   FROM regexp_split_to_table(btrim(COALESCE(NULLIF(btrim(en), ''), btrim(bn))), '\s+') WITH ORDINALITY AS t(w, i)
                   WHERE w <> ''), '—');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION rx_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'facilityEn', o."name", 'facilityBn', o."nameBn",
    'doctorEn', u."nameEn", 'doctorBn', u."nameBn", 'regBody', pr."regBody", 'regNo', pr."regNo", 'regVerified', COALESCE(pr."regVerified", false),
    'signedAt', c."signedAt", 'version', c."version", 'status', c."status",
    'initials', person_initials(p."nameEn", p."nameBn"), 'sex', p."sex",
    'birthDate', to_char(p."birthDate", 'YYYY-MM-DD'), 'approxAgeYears', p."approxAgeYears", 'approxAgeAt', p."approxAgeAt",
    'medicines', COALESCE((SELECT jsonb_agg(jsonb_build_object('brand', m."brand", 'generic', m."generic", 'strength', m."strength", 'form', m."form",
                                  'dose', m."dose", 'meal', m."meal", 'days', m."days", 'quantity', m."quantity") ORDER BY m."position")
                           FROM "MedicationRequest" m WHERE m."compositionId" = c."id" AND m."tenantId" = c."tenantId"), '[]'::jsonb))
  FROM "DocumentCode" d
  JOIN "Composition" c ON c."id" = d."documentId" AND c."tenantId" = d."tenantId"
  JOIN "Organization" o ON o."id" = c."organizationId"
  JOIN "Patient" p ON p."id" = c."patientId"
  LEFT JOIN "User" u ON u."id" = c."signedById"
  LEFT JOIN "Practitioner" pr ON pr."userId" = c."signedById"
  WHERE d."verifyCode" = p_code AND d."kind" = 'rx'
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION rx_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rx_verify_lookup(text) TO setu_app;

CREATE OR REPLACE FUNCTION lr_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'facilityEn', o."name", 'facilityBn', o."nameBn",
    'number', r."number", 'version', r."version", 'status', r."status", 'superseded', r."supersededById" IS NOT NULL,
    'releasedAt', r."releasedAt", 'testCount', r."testCount", 'pendingCount', r."pendingCount",
    'initials', person_initials(p."nameEn", p."nameBn"), 'sex', p."sex",
    'birthDate', to_char(p."birthDate", 'YYYY-MM-DD'), 'approxAgeYears', p."approxAgeYears", 'approxAgeAt', p."approxAgeAt",
    'results', COALESCE((SELECT jsonb_agg(jsonb_build_object('test', s."nameEn", 'code', ob."code", 'nameEn', a."nameEn", 'nameBn', a."nameBn",
                                'value', ob."value", 'unit', ob."unit", 'decimals', a."decimals", 'flag', ob."interpretation",
                                'refLow', ob."refLow", 'refHigh', ob."refHigh", 'refLabel', ob."refLabel",
                                'underCorrection', ob."status" = 'entered-in-error') ORDER BY s."nameEn", a."code")
                         FROM "DiagnosticReportResult" x
                         JOIN "Observation" ob ON ob."id" = x."observationId" AND ob."tenantId" = x."tenantId"
                         JOIN "ServiceRequest" s ON s."id" = x."serviceRequestId" AND s."tenantId" = x."tenantId"
                         LEFT JOIN "LabAnalyte" a ON a."tenantId" = x."tenantId" AND a."code" = ob."code"
                         WHERE x."reportId" = r."id"), '[]'::jsonb))
  FROM "DocumentCode" d
  JOIN "DiagnosticReport" r ON r."id" = d."documentId" AND r."tenantId" = d."tenantId"
  JOIN "Organization" o ON o."id" = r."organizationId"
  JOIN "Patient" p ON p."id" = r."patientId"
  WHERE d."verifyCode" = p_code AND d."kind" = 'lr'
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION lr_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lr_verify_lookup(text) TO setu_app;
