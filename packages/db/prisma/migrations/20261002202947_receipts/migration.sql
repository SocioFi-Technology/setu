-- DropIndex
DROP INDEX "Payment_supersededRefs";

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "verifyCode" TEXT NOT NULL,
    "paidPaisa" INTEGER NOT NULL,
    "totalPaisa" INTEGER NOT NULL,
    "duePaisa" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptPrint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "copy" INTEGER NOT NULL,
    "reason" TEXT,
    "format" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "printedById" TEXT NOT NULL,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptPrint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_verifyCode_key" ON "Receipt"("verifyCode");

-- CreateIndex
CREATE INDEX "Receipt_tenantId_invoiceId_idx" ON "Receipt"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_tenantId_organizationId_number_key" ON "Receipt"("tenantId", "organizationId", "number");

-- CreateIndex
CREATE INDEX "ReceiptPrint_tenantId_receiptId_idx" ON "ReceiptPrint"("tenantId", "receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptPrint_receiptId_copy_key" ON "ReceiptPrint"("receiptId", "copy");

-- AddForeignKey
ALTER TABLE "ReceiptPrint" ADD CONSTRAINT "ReceiptPrint_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- A receipt is an immutable copy of what was printed; prints are an append-only log. Every role, the owner included.
REVOKE UPDATE, DELETE ON "Receipt", "ReceiptPrint" FROM setu_app;
CREATE OR REPLACE FUNCTION receipt_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: a printed receipt is never changed or deleted', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON "Receipt" FOR EACH ROW EXECUTE FUNCTION receipt_immutable();
CREATE TRIGGER receipt_print_immutable BEFORE UPDATE OR DELETE ON "ReceiptPrint" FOR EACH ROW EXECUTE FUNCTION receipt_immutable();

ALTER TABLE "Receipt" ADD CONSTRAINT receipt_amounts CHECK ("paidPaisa" > 0 AND "totalPaisa" >= 0 AND "duePaisa" >= 0 AND "paidPaisa" + "duePaisa" = "totalPaisa");
-- ≥16 characters from the receipt alphabet (random, never sequential — the API generates it from crypto.randomBytes).
ALTER TABLE "Receipt" ADD CONSTRAINT receipt_verify_code CHECK ("verifyCode" ~ '^[0-9A-HJKMNP-TV-Z]{16,}$');
ALTER TABLE "ReceiptPrint" ADD CONSTRAINT receipt_print_shape CHECK (
  "copy" >= 0 AND "format" IN ('a5', 'thermal') AND "lang" IN ('both', 'bn', 'en')
  AND (("copy" = 0) = ("reason" IS NULL)));

-- The public verify page (no session) reads only this: facility, receipt number, date, amount. Never the patient.
CREATE OR REPLACE FUNCTION receipt_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('facilityEn', o."name", 'facilityBn', o."nameBn", 'number', r."number", 'createdAt', r."createdAt", 'paidPaisa', r."paidPaisa")
  FROM "Receipt" r JOIN "Organization" o ON o."id" = r."organizationId"
  WHERE r."verifyCode" = p_code
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION receipt_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION receipt_verify_lookup(text) TO setu_app;
