-- ADR 0023 (E4): another clinic's view of a patient's history — blood group on the record, access requests, a
-- consent limited to the kinds the patient approved.

-- decision 4: blood group, a field on the record (source = this facility, who and when)
ALTER TABLE "Patient" ADD COLUMN "bloodGroup" TEXT, ADD COLUMN "bloodGroupAt" TIMESTAMP(3), ADD COLUMN "bloodGroupById" TEXT;
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_bloodGroup_check"
  CHECK ("bloodGroup" IS NULL OR ("bloodGroup" IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') AND "bloodGroupAt" IS NOT NULL AND "bloodGroupById" IS NOT NULL));

-- a consent from an access request: the kinds approved (empty = every kind — the patient's own shares) and the request
ALTER TABLE "Consent" ADD COLUMN "kinds" TEXT[] NOT NULL DEFAULT '{}', ADD COLUMN "requestId" TEXT;
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_kinds_check"
  CHECK ("kinds" <@ ARRAY['visit', 'admission', 'report', 'prescription', 'summary']::text[] AND ("basis" <> 'patient-request' OR ("requestId" IS NOT NULL AND cardinality("kinds") > 0 AND "scope" = 'all')));

-- a doctor's request to see more of a patient's history (network level: the person answers it in the app)
CREATE TABLE "AccessRequest" (
  "id"                     TEXT NOT NULL PRIMARY KEY,
  "personId"               TEXT NOT NULL,
  "requesterTenantId"      TEXT NOT NULL,
  "requesterOrganizationId" TEXT NOT NULL,
  "requesterUserId"        TEXT NOT NULL,
  "requesterPatientId"     TEXT NOT NULL,
  -- the names when it was made (the patient's list never reads another tenant for them)
  "facilityEn"             TEXT NOT NULL,
  "facilityBn"             TEXT,
  "doctorEn"               TEXT NOT NULL,
  "doctorBn"               TEXT,
  "kinds"                  TEXT[] NOT NULL,
  "period"                 TEXT NOT NULL,
  "reason"                 TEXT NOT NULL,
  "state"                  TEXT NOT NULL DEFAULT 'sent',
  "answeredAt"             TIMESTAMP(3),
  "consentId"              TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccessRequest_person_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT,
  CONSTRAINT "AccessRequest_consent_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent"("id") ON DELETE RESTRICT,
  CONSTRAINT "AccessRequest_check" CHECK (
    "state" IN ('sent', 'granted', 'denied', 'expired')
    AND cardinality("kinds") > 0 AND "kinds" <@ ARRAY['reports', 'summaries', 'prescriptions', 'visits']::text[]
    AND "period" IN ('24h', '30d') AND char_length(btrim("reason")) >= 10
    AND (("state" = 'sent') = ("answeredAt" IS NULL)) AND (("state" = 'granted') = ("consentId" IS NOT NULL)))
);
CREATE INDEX "AccessRequest_person_idx" ON "AccessRequest"("personId", "createdAt");
CREATE INDEX "AccessRequest_requester_idx" ON "AccessRequest"("requesterTenantId", "requesterPatientId", "createdAt");
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_request_fkey" FOREIGN KEY ("requestId") REFERENCES "AccessRequest"("id") ON DELETE RESTRICT;

ALTER TABLE "AccessRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccessRequest" FORCE ROW LEVEL SECURITY;
-- the person reads and answers their requests; the requesting facility makes and reads its own
CREATE POLICY person_read ON "AccessRequest" FOR SELECT USING ("personId" = current_setting('app.person_id', true));
CREATE POLICY person_answer ON "AccessRequest" FOR UPDATE USING ("personId" = current_setting('app.person_id', true)) WITH CHECK ("personId" = current_setting('app.person_id', true));
CREATE POLICY requester_read ON "AccessRequest" FOR SELECT USING ("requesterTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY requester_insert ON "AccessRequest" FOR INSERT WITH CHECK ("requesterTenantId" = current_setting('app.tenant_id', true) AND "state" = 'sent');
GRANT SELECT, INSERT, UPDATE ON "AccessRequest" TO setu_app;

-- answered once: sent → granted | denied | expired; nothing else of the request changes
CREATE OR REPLACE FUNCTION access_request_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD."state" <> 'sent' OR NEW."state" = 'sent' THEN
    RAISE EXCEPTION 'AccessRequest %: answered once', OLD."id";
  END IF;
  IF (NEW."personId", NEW."requesterTenantId", NEW."requesterOrganizationId", NEW."requesterUserId", NEW."requesterPatientId", NEW."kinds", NEW."period", NEW."reason", NEW."createdAt")
     IS DISTINCT FROM (OLD."personId", OLD."requesterTenantId", OLD."requesterOrganizationId", OLD."requesterUserId", OLD."requesterPatientId", OLD."kinds", OLD."period", OLD."reason", OLD."createdAt") THEN
    RAISE EXCEPTION 'AccessRequest %: only the answer changes', OLD."id";
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER access_request_guard BEFORE UPDATE ON "AccessRequest" FOR EACH ROW EXECUTE FUNCTION access_request_guard();

-- the person's "network sharing" setting, for a facility deciding what another facility may see (SECURITY DEFINER:
-- Person rows are the person's own)
CREATE OR REPLACE FUNCTION person_network_sharing(p_person text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT p."networkSharing" FROM "Person" p WHERE p."id" = p_person), false);
$$;
REVOKE ALL ON FUNCTION person_network_sharing(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_network_sharing(text) TO setu_app;
