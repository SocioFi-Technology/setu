-- ADR 0017 (decision 10): each print of the interim bill — copy 0 the original, a reprint needs a reason. Append-only.
CREATE TABLE "InterimBillPrint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "copy" INTEGER NOT NULL,
    "reason" TEXT,
    "lang" TEXT NOT NULL,
    "totalPaisa" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "printedById" TEXT NOT NULL,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InterimBillPrint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT interim_print_shape CHECK ("copy" >= 0 AND ("copy" = 0) = ("reason" IS NULL) AND "lang" IN ('both', 'bn', 'en'))
);
CREATE UNIQUE INDEX "InterimBillPrint_invoiceId_copy_key" ON "InterimBillPrint"("invoiceId", "copy");
CREATE OR REPLACE FUNCTION interim_print_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'InterimBillPrint: a print is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."printedById") THEN RAISE EXCEPTION 'InterimBillPrint: printed by the signed-in user'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i."id" = NEW."invoiceId" AND i."kind" = 'ipd' AND i."tenantId" = NEW."tenantId") THEN RAISE EXCEPTION 'InterimBillPrint: for an IPD bill'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER interim_print_guard BEFORE INSERT OR UPDATE OR DELETE ON "InterimBillPrint" FOR EACH ROW EXECUTE FUNCTION interim_print_guard();
ALTER TABLE "InterimBillPrint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterimBillPrint" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InterimBillPrint" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
REVOKE DELETE, UPDATE ON "InterimBillPrint" FROM setu_app;
