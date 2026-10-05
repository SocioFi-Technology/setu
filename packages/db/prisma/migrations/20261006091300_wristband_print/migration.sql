-- ADR 0016: wristband prints — the first one at admission, a reprint with a reason (≥5); append-only, by the signed-in user.
CREATE TABLE "WristbandPrint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "reason" TEXT,
    "printedById" TEXT NOT NULL,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WristbandPrint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WristbandPrint_tenantId_admissionId_idx" ON "WristbandPrint"("tenantId", "admissionId");
CREATE OR REPLACE FUNCTION wristband_print_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'WristbandPrint: a print record is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."printedById") THEN RAISE EXCEPTION 'WristbandPrint: printed by the signed-in user'; END IF;
  IF EXISTS (SELECT 1 FROM "WristbandPrint" w WHERE w."admissionId" = NEW."admissionId") AND char_length(btrim(coalesce(NEW."reason", ''))) < 5 THEN
    RAISE EXCEPTION 'WristbandPrint: a reprint has a reason';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER wristband_print_guard BEFORE INSERT OR UPDATE OR DELETE ON "WristbandPrint" FOR EACH ROW EXECUTE FUNCTION wristband_print_guard();
ALTER TABLE "WristbandPrint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WristbandPrint" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WristbandPrint" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
REVOKE DELETE, UPDATE ON "WristbandPrint" FROM setu_app;
