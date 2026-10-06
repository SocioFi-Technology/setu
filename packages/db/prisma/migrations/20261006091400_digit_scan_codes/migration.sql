-- ADR 0016 amendment 2 (Kamrul, 06/10/2026): scan codes are digits only, so a keyboard-wedge scanner works under a Bangla
-- layout. A wristband print gets a 10-digit serial (its code: 91 + serial + an 8-digit signature); a ward batch gets a
-- label serial (its code: 92 + serial + mod-97 check digits). Earlier lettered codes no longer verify (reprint the band).
ALTER TABLE "WristbandPrint" ADD COLUMN "serial" TEXT;
CREATE UNIQUE INDEX "WristbandPrint_tenantId_serial_key" ON "WristbandPrint"("tenantId", "serial");
ALTER TABLE "WristbandPrint" ADD CONSTRAINT wristband_print_serial CHECK ("serial" IS NULL OR "serial" ~ '^\d{10}$');

CREATE TABLE "BatchLabel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BatchLabel_pkey" PRIMARY KEY ("id"),
    CONSTRAINT batch_label_serial CHECK ("serial" ~ '^\d{10}$')
);
CREATE UNIQUE INDEX "BatchLabel_tenantId_batchId_key" ON "BatchLabel"("tenantId", "batchId");
CREATE UNIQUE INDEX "BatchLabel_tenantId_serial_key" ON "BatchLabel"("tenantId", "serial");
CREATE OR REPLACE FUNCTION batch_label_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'BatchLabel: a label is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."createdById") THEN RAISE EXCEPTION 'BatchLabel: made by the signed-in user'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "StockBatch" b WHERE b."id" = NEW."batchId" AND b."organizationId" = NEW."organizationId" AND b."location" LIKE 'ward:%') THEN
    RAISE EXCEPTION 'BatchLabel: a label is for a ward batch of this facility';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER batch_label_guard BEFORE INSERT OR UPDATE OR DELETE ON "BatchLabel" FOR EACH ROW EXECUTE FUNCTION batch_label_guard();
ALTER TABLE "BatchLabel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BatchLabel" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BatchLabel" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
REVOKE DELETE, UPDATE ON "BatchLabel" FROM setu_app;
