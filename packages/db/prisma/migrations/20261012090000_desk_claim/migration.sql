-- ADR 0024: the reception confirms a patient-app claim in person. The app shows a desk code (only its hash is kept,
-- so no one reading the table can use it); the receptionist types it, checks an identity document and picks the
-- record on the person's phone — or says it could not be verified.
ALTER TABLE "PatientClaim"
  ADD COLUMN "deskCodeHash" TEXT,
  ADD COLUMN "deskCodeUntil" TIMESTAMP(3),
  -- nid | birth-reg: the document checked (its number is not copied)
  ADD COLUMN "deskDocument" TEXT,
  ADD COLUMN "deskById" TEXT,
  ADD COLUMN "deskAt" TIMESTAMP(3),
  ADD COLUMN "deskRefusedAt" TIMESTAMP(3);
ALTER TABLE "PatientClaim" ADD CONSTRAINT "PatientClaim_desk_check" CHECK (
  ("deskCodeHash" IS NULL) = ("deskCodeUntil" IS NULL)
  AND ("deskCodeHash" IS NULL OR ("status" = 'proof-pending' AND "method" = 'desk'))
  AND ("deskDocument" IS NULL OR ("deskDocument" IN ('nid', 'birth-reg') AND "status" = 'linked' AND "method" = 'desk' AND "deskById" IS NOT NULL AND "deskAt" IS NOT NULL))
);
-- a code finds one claim in its facility
CREATE UNIQUE INDEX "PatientClaim_desk_code_key" ON "PatientClaim"("tenantId", "deskCodeHash") WHERE "deskCodeHash" IS NOT NULL;

-- the phone of the person behind a claim waiting at this facility's desk (Person rows are the person's own — SECURITY
-- DEFINER): only for a claim of the caller's tenant that is waiting for the desk
CREATE OR REPLACE FUNCTION desk_claim_phone(p_claim text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p."phone" FROM "PatientClaim" c JOIN "Person" p ON p."id" = c."personId"
  WHERE c."id" = p_claim AND c."tenantId" = current_setting('app.tenant_id', true)
    AND c."status" = 'proof-pending' AND c."method" = 'desk';
$$;
REVOKE ALL ON FUNCTION desk_claim_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_claim_phone(text) TO setu_app;
