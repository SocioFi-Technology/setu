-- ADR 0021 (slice D4–D6): the patient's shares (Consent, network level), each share's opens, the network directory,
-- the facility's phone and network membership, and the patient app's read marks on the facility's notices.

ALTER TABLE "Organization" ADD COLUMN "phone" TEXT;
-- joined the Setu network: patients can share their records with this facility's doctors (owner / admin sets it)
ALTER TABLE "Organization" ADD COLUMN "networkJoinedAt" TIMESTAMP(3);
ALTER TABLE "Communication" ADD COLUMN "readAt" TIMESTAMP(3);

-- the composite keys below need (tenantId, id) unique on the grantee's facility and doctor (as Patient, gap 10)
CREATE UNIQUE INDEX "Organization_tenantId_id_key" ON "Organization" ("tenantId", "id");
CREATE UNIQUE INDEX "User_tenantId_id_key" ON "User" ("tenantId", "id");

CREATE TYPE "ConsentStatus" AS ENUM ('proposed', 'active', 'revoked', 'expired', 'ended', 'reviewed');
CREATE TYPE "ShareScope" AS ENUM ('all', 'visit', 'report');

CREATE TABLE "Consent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "personId" TEXT NOT NULL,
  "basis" TEXT NOT NULL DEFAULT 'patient',
  "granteeTenantId" TEXT NOT NULL,
  "granteeOrganizationId" TEXT NOT NULL,
  "granteeUserId" TEXT,
  "scope" "ShareScope" NOT NULL,
  "scopeTenantId" TEXT,
  "scopePatientId" TEXT,
  "scopeRecordId" TEXT,
  "period" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "status" "ConsentStatus" NOT NULL DEFAULT 'active',
  "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Consent_person_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT,
  CONSTRAINT "Consent_grantee_tenant_fkey" FOREIGN KEY ("granteeTenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT,
  -- the grantee facility belongs to the grantee tenant; a named doctor to the same tenant (composite keys, gap 10)
  CONSTRAINT "Consent_grantee_org_fkey" FOREIGN KEY ("granteeTenantId", "granteeOrganizationId") REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "Consent_grantee_user_fkey" FOREIGN KEY ("granteeTenantId", "granteeUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT,
  -- "all" names no record; a visit or a report names its tenant, patient and record
  CONSTRAINT "Consent_scope_shape" CHECK (("scope" = 'all') = ("scopeTenantId" IS NULL AND "scopePatientId" IS NULL AND "scopeRecordId" IS NULL)
    AND ("scope" = 'all' OR ("scopeTenantId" IS NOT NULL AND "scopePatientId" IS NOT NULL AND "scopeRecordId" IS NOT NULL))),
  CONSTRAINT "Consent_period" CHECK ("endsAt" > "startsAt" AND "period" IN ('24h', '7d', '30d')),
  CONSTRAINT "Consent_revoked_has_time" CHECK (("status" = 'revoked') = ("revokedAt" IS NOT NULL))
);
CREATE INDEX "Consent_personId_idx" ON "Consent"("personId", "createdAt");
CREATE INDEX "Consent_grantee_idx" ON "Consent"("granteeTenantId", "status", "endsAt");

-- each read of a share by the receiving doctor (the patient's "who opened it and when")
CREATE TABLE "ConsentAccess" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "consentId" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "granteeTenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "userNameEn" TEXT NOT NULL,
  "userNameBn" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "facilityEn" TEXT NOT NULL,
  "facilityBn" TEXT,
  -- what was opened: the owner tenant, the kind and the record
  "ownerTenantId" TEXT NOT NULL,
  "itemKind" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentAccess_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ConsentAccess_consent_idx" ON "ConsentAccess"("consentId", "at");
CREATE INDEX "ConsentAccess_person_idx" ON "ConsentAccess"("personId", "at");

-- row-level security: the person reads and writes their own shares and reads their opens; the receiving tenant reads
-- the shares given to it (never writes them) and records its own opens
ALTER TABLE "Consent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Consent" FORCE ROW LEVEL SECURITY;
CREATE POLICY person_self ON "Consent" USING ("personId" = current_setting('app.person_id', true)) WITH CHECK ("personId" = current_setting('app.person_id', true));
CREATE POLICY grantee_read ON "Consent" FOR SELECT USING ("granteeTenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "ConsentAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConsentAccess" FORCE ROW LEVEL SECURITY;
CREATE POLICY person_read ON "ConsentAccess" FOR SELECT USING ("personId" = current_setting('app.person_id', true));
CREATE POLICY grantee_read ON "ConsentAccess" FOR SELECT USING ("granteeTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY grantee_insert ON "ConsentAccess" FOR INSERT WITH CHECK ("granteeTenantId" = current_setting('app.tenant_id', true));
-- a grantee can only record an open of a share given to it, about that share's person
CREATE OR REPLACE FUNCTION consent_access_matches() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Consent" c WHERE c."id" = NEW."consentId" AND c."personId" = NEW."personId" AND c."granteeTenantId" = NEW."granteeTenantId") THEN
    RAISE EXCEPTION 'ConsentAccess does not match its consent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_access_matches BEFORE INSERT ON "ConsentAccess" FOR EACH ROW EXECUTE FUNCTION consent_access_matches();

-- The network directory (SECURITY DEFINER): facilities that joined the network and their active doctors — names only.
CREATE OR REPLACE FUNCTION network_directory() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tenantId', o."tenantId", 'organizationId', o."id", 'nameEn', o."name", 'nameBn', o."nameBn",
    'doctors', coalesce((SELECT jsonb_agg(jsonb_build_object('userId', u."id", 'nameEn', u."nameEn", 'nameBn', u."nameBn") ORDER BY u."nameEn")
      FROM "User" u WHERE u."tenantId" = o."tenantId" AND u."active" AND NOT u."system"
        AND EXISTS (SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = u."id" AND r."tenantId" = u."tenantId" AND r."organizationId" = o."id" AND r."role" = 'doctor')), '[]'::jsonb)
  ) ORDER BY o."name"), '[]'::jsonb)
  FROM "Organization" o WHERE o."networkJoinedAt" IS NOT NULL AND o."status" = 'live';
$$;
REVOKE ALL ON FUNCTION network_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network_directory() TO setu_app;

-- the expiry sweep (one job instance): active shares past their end → expired; returns how many
CREATE OR REPLACE FUNCTION consent_expire_due() RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (UPDATE "Consent" SET "status" = 'expired', "statusAt" = now() WHERE "status" = 'active' AND "endsAt" <= now() RETURNING 1)
  SELECT count(*)::int FROM u;
$$;
REVOKE ALL ON FUNCTION consent_expire_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consent_expire_due() TO setu_app;

