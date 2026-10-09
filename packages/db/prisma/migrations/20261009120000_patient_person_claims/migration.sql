-- ADR 0020 (slice D1–D3): the patient app's Person (network level), claims (per tenant), the person's idempotency
-- records, and the claim code every patient carries.

-- the claim code: 6 characters from an alphabet without 0 / O / 1 / I / L (read aloud and typed on a phone)
CREATE OR REPLACE FUNCTION gen_claim_code() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + floor(random() * 31)::int, 1), '') FROM generate_series(1, 6);
$$;
ALTER TABLE "Patient" ADD COLUMN "claimCode" TEXT DEFAULT gen_claim_code();
UPDATE "Patient" SET "claimCode" = gen_claim_code() WHERE "claimCode" IS NULL;
-- a collision in a tenant (31^6 ≈ 887 million) is drawn again
DO $$ DECLARE n int; BEGIN
  LOOP
    UPDATE "Patient" p SET "claimCode" = gen_claim_code()
      WHERE p."id" IN (SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "tenantId", "claimCode" ORDER BY "id") AS rn FROM "Patient") x WHERE rn > 1);
    GET DIAGNOSTICS n = ROW_COUNT; EXIT WHEN n = 0;
  END LOOP; END $$;
CREATE UNIQUE INDEX "Patient_tenantId_claimCode_key" ON "Patient"("tenantId", "claimCode");

CREATE TYPE "ClaimStatus" AS ENUM ('candidate', 'proof-pending', 'linked', 'not-mine', 'locked');

CREATE TABLE "Person" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "phone" TEXT NOT NULL,
  "lang" TEXT NOT NULL DEFAULT 'bn',
  "networkSharing" BOOLEAN NOT NULL DEFAULT true,
  "sessionGeneration" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSignInAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "Person_phone_key" ON "Person"("phone");

CREATE TABLE "PatientClaim" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "status" "ClaimStatus" NOT NULL DEFAULT 'candidate',
  "method" TEXT,
  "tries" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "patientId" TEXT,
  "linkedAt" TIMESTAMP(3),
  "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientClaim_person_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT,
  -- the linked record is this tenant's patient (composite key, gap 10)
  CONSTRAINT "PatientClaim_tenant_patient_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT,
  -- linked ⇔ a patient and a time; a tries count never above the limit
  CONSTRAINT "PatientClaim_linked_has_patient" CHECK (("status" = 'linked') = ("patientId" IS NOT NULL AND "linkedAt" IS NOT NULL)),
  CONSTRAINT "PatientClaim_tries" CHECK ("tries" BETWEEN 0 AND 3)
);
CREATE UNIQUE INDEX "PatientClaim_tenantId_personId_key" ON "PatientClaim"("tenantId", "personId");
CREATE INDEX "PatientClaim_tenantId_patientId_idx" ON "PatientClaim"("tenantId", "patientId");
CREATE INDEX "PatientClaim_personId_idx" ON "PatientClaim"("personId");

CREATE TABLE "PersonIdempotency" (
  "personId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonIdempotency_pkey" PRIMARY KEY ("personId", "key", "route"),
  CONSTRAINT "PersonIdempotency_person_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE
);

-- row-level security: the claim per tenant; the person and their idempotency rows per person
ALTER TABLE "PatientClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PatientClaim" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PatientClaim" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "Person" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Person" FORCE ROW LEVEL SECURITY;
CREATE POLICY person_self ON "Person" USING ("id" = current_setting('app.person_id', true)) WITH CHECK ("id" = current_setting('app.person_id', true));
ALTER TABLE "PersonIdempotency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PersonIdempotency" FORCE ROW LEVEL SECURITY;
CREATE POLICY person_self ON "PersonIdempotency" USING ("personId" = current_setting('app.person_id', true)) WITH CHECK ("personId" = current_setting('app.person_id', true));

-- The pre-person reads (SECURITY DEFINER, like auth_login_lookup): each returns ids, facility names and months only.

-- sign-in: the person for a phone, made on the first sign-in
CREATE OR REPLACE FUNCTION person_upsert(p_phone text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO "Person" ("id", "phone", "lastSignInAt") VALUES ('per_' || replace(gen_random_uuid()::text, '-', ''), p_phone, now())
  ON CONFLICT ("phone") DO UPDATE SET "lastSignInAt" = now()
  RETURNING jsonb_build_object('id', "id", 'lang', "lang", 'generation', "sessionGeneration");
$$;
REVOKE ALL ON FUNCTION person_upsert(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_upsert(text) TO setu_app;

-- the candidates for a phone: one per tenant with a patient on it — the facility of the last visit and its month
CREATE OR REPLACE FUNCTION person_candidates(p_phone text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH pts AS (
    SELECT p."tenantId", p."id", p."createdAt" FROM "Patient" p WHERE p."phone" = p_phone AND p."linkedToId" IS NULL
  ), last AS (
    SELECT DISTINCT ON (pts."tenantId") pts."tenantId", e."organizationId", coalesce(e."arrivedAt", e."createdAt", pts."createdAt") AS at
    FROM pts LEFT JOIN "Encounter" e ON e."patientId" = pts."id" AND e."tenantId" = pts."tenantId"
    ORDER BY pts."tenantId", coalesce(e."arrivedAt", e."createdAt", pts."createdAt") DESC
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tenantId', l."tenantId",
    'facilityEn', coalesce(o."name", (SELECT o2."name" FROM "Organization" o2 WHERE o2."tenantId" = l."tenantId" ORDER BY o2."id" LIMIT 1)),
    'facilityBn', coalesce(o."nameBn", (SELECT o2."nameBn" FROM "Organization" o2 WHERE o2."tenantId" = l."tenantId" ORDER BY o2."id" LIMIT 1)),
    'lastMonth', to_char(l.at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM')
  ) ORDER BY l.at DESC), '[]'::jsonb)
  FROM last l LEFT JOIN "Organization" o ON o."id" = l."organizationId";
$$;
REVOKE ALL ON FUNCTION person_candidates(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_candidates(text) TO setu_app;

-- a person's claims across tenants (ids and states only — the records are read per tenant)
CREATE OR REPLACE FUNCTION person_claims(p_person text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c."id", 'tenantId', c."tenantId", 'status', c."status", 'patientId', c."patientId") ORDER BY c."createdAt"), '[]'::jsonb)
  FROM "PatientClaim" c WHERE c."personId" = p_person;
$$;
REVOKE ALL ON FUNCTION person_claims(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_claims(text) TO setu_app;
