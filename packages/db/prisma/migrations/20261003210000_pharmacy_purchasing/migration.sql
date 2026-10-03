-- Pharmacy session 2 (ADR 0009): suppliers, purchase orders, goods received, the supplier ledger and stock counts.
-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('draft', 'sent', 'partially-received', 'received', 'cancelled');

-- CreateEnum
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('checking', 'posted', 'discarded');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('counting', 'submitted', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sample" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "number" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
    "totalPaisa" INTEGER NOT NULL DEFAULT 0,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "approvalTaskId" TEXT,
    "note" TEXT,
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "costPaisa" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "number" TEXT,
    "supplierInvoiceNo" TEXT,
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'checking',
    "rev" INTEGER NOT NULL DEFAULT 1,
    "invoicedPaisa" INTEGER NOT NULL DEFAULT 0,
    "debitNotePaisa" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "expiry" TEXT NOT NULL,
    "invoicedQty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL,
    "costPaisa" INTEGER NOT NULL,
    "mrpPaisa" INTEGER NOT NULL,
    "vatRateBp" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT NOT NULL DEFAULT 'store',
    "batchId" TEXT,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountPaisa" INTEGER NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "note" TEXT,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'counting',
    "rev" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "systemQty" INTEGER NOT NULL,
    "countedQty" INTEGER,
    "reason" TEXT,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_organizationId_name_key" ON "Supplier"("tenantId", "organizationId", "name");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_organizationId_status_idx" ON "PurchaseOrder"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_tenantId_orderId_idx" ON "PurchaseOrderLine"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_tenantId_orderId_idx" ON "GoodsReceipt"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_tenantId_receiptId_idx" ON "GoodsReceiptLine"("tenantId", "receiptId");

-- CreateIndex
CREATE INDEX "SupplierEntry_tenantId_supplierId_idx" ON "SupplierEntry"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "StockCount_tenantId_organizationId_status_idx" ON "StockCount"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_batchId_key" ON "StockCountLine"("countId", "batchId");

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───── Row-level security for the new tables (same loop as rls.sql) ─────
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

-- ───── shapes ─────
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT po_line_shape CHECK ("qty" > 0 AND "costPaisa" >= 0 AND "receivedQty" BETWEEN 0 AND "qty");
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT po_shape CHECK ("totalPaisa" >= 0 AND ("status" <> 'cancelled' OR char_length(btrim(coalesce("cancelReason", ''))) >= 10));
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT grn_line_shape CHECK (
  "invoicedQty" > 0 AND "receivedQty" BETWEEN 0 AND "invoicedQty" AND "costPaisa" >= 0 AND "mrpPaisa" >= "costPaisa"
  AND "vatRateBp" BETWEEN 0 AND 10000 AND "expiry" ~ '^\d{4}-\d{2}-\d{2}$' AND "location" IN ('counter', 'store', 'fridge')
  AND char_length(btrim("batchNo")) > 0);
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT grn_shape CHECK ("invoicedPaisa" >= 0 AND "debitNotePaisa" BETWEEN 0 AND "invoicedPaisa");
ALTER TABLE "SupplierEntry" ADD CONSTRAINT supplier_entry_shape CHECK ("amountPaisa" > 0 AND "kind" IN ('goods-received', 'debit-note', 'payment'));
ALTER TABLE "StockCount" ADD CONSTRAINT stock_count_shape CHECK ("location" IN ('counter', 'store', 'fridge'));
ALTER TABLE "StockCountLine" ADD CONSTRAINT stock_count_line_shape CHECK ("systemQty" >= 0 AND ("countedQty" IS NULL OR "countedQty" >= 0));

-- ───── the supplier ledger is append-only, written by the signed-in user ─────
REVOKE UPDATE, DELETE ON "SupplierEntry" FROM setu_app;
CREATE TRIGGER supplier_entry_immutable BEFORE UPDATE OR DELETE ON "SupplierEntry" FOR EACH ROW EXECUTE FUNCTION pharmacy_record_immutable();
CREATE OR REPLACE FUNCTION supplier_entry_actor() RETURNS trigger AS $$
BEGIN
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'SupplierEntry: recorded by someone other than the signed-in user'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER supplier_entry_actor BEFORE INSERT ON "SupplierEntry" FOR EACH ROW EXECUTE FUNCTION supplier_entry_actor();

-- ───── purchase orders: one machine step at a time; lines change only on a draft (received quantity as goods arrive) ─────
CREATE OR REPLACE FUNCTION purchase_order_guard() RETURNS trigger AS $$
DECLARE total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PurchaseOrder is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' THEN RAISE EXCEPTION 'PurchaseOrder: a new order starts as a draft'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."createdById", NEW."createdAt") IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."createdById", OLD."createdAt")
     OR (OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number")
     OR (OLD."status" <> 'draft' AND (NEW."supplierId", NEW."totalPaisa", NEW."sentById", NEW."sentAt") IS DISTINCT FROM (OLD."supplierId", OLD."totalPaisa", OLD."sentById", OLD."sentAt")) THEN
    RAISE EXCEPTION 'PurchaseOrder %: a sent order is not edited', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'draft' AND NEW."status" IN ('sent', 'cancelled'))
    OR (OLD."status" = 'sent' AND NEW."status" IN ('partially-received', 'received', 'cancelled'))
    OR (OLD."status" = 'partially-received' AND NEW."status" = 'received')) THEN
    RAISE EXCEPTION 'PurchaseOrder %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF OLD."status" = 'draft' AND NEW."status" = 'sent' THEN
    SELECT coalesce(sum("qty"::bigint * "costPaisa"), 0) INTO total FROM "PurchaseOrderLine" WHERE "orderId" = NEW."id";
    IF total = 0 AND NOT EXISTS (SELECT 1 FROM "PurchaseOrderLine" WHERE "orderId" = NEW."id") THEN RAISE EXCEPTION 'PurchaseOrder %: no lines', OLD."id"; END IF;
    IF total <> NEW."totalPaisa" THEN RAISE EXCEPTION 'PurchaseOrder %: total is not the sum of its lines', OLD."id"; END IF;
    IF NEW."number" IS NULL OR NEW."sentById" IS NULL OR NOT lab_actor_ok(NEW."sentById") THEN RAISE EXCEPTION 'PurchaseOrder %: sent with a number, by the signed-in user', OLD."id"; END IF;
  END IF;
  IF OLD."status" IN ('sent', 'partially-received') AND NEW."status" = 'cancelled'
     AND EXISTS (SELECT 1 FROM "PurchaseOrderLine" WHERE "orderId" = NEW."id" AND "receivedQty" > 0) THEN
    RAISE EXCEPTION 'PurchaseOrder %: goods already arrived — close it short instead', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_order_guard BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION purchase_order_guard();

CREATE OR REPLACE FUNCTION purchase_order_line_guard() RETURNS trigger AS $$
DECLARE st "PurchaseOrderStatus";
BEGIN
  SELECT "status" INTO st FROM "PurchaseOrder" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."orderId" ELSE NEW."orderId" END);
  IF TG_OP = 'UPDATE' AND (NEW."orderId", NEW."medicineKey", NEW."qty", NEW."costPaisa", NEW."position") IS NOT DISTINCT FROM (OLD."orderId", OLD."medicineKey", OLD."qty", OLD."costPaisa", OLD."position") THEN
    -- only the received quantity moves: up, while the order is open for goods (posting a goods receipt)
    IF NEW."receivedQty" < OLD."receivedQty" OR st NOT IN ('sent', 'partially-received') THEN RAISE EXCEPTION 'PurchaseOrderLine: received quantity only grows on an open order'; END IF;
    RETURN NEW;
  END IF;
  IF st <> 'draft' THEN RAISE EXCEPTION 'PurchaseOrderLine: lines change only while the order is a draft'; END IF;
  IF TG_OP <> 'DELETE' AND NEW."receivedQty" <> 0 THEN RAISE EXCEPTION 'PurchaseOrderLine: nothing is received on a draft'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_order_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "PurchaseOrderLine" FOR EACH ROW EXECUTE FUNCTION purchase_order_line_guard();

-- ───── goods receipts: checked, then posted once; a posted receipt and its lines never change ─────
CREATE OR REPLACE FUNCTION goods_receipt_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GoodsReceipt is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'checking' THEN RAISE EXCEPTION 'GoodsReceipt: a new receipt starts in checking'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "PurchaseOrder" o WHERE o."id" = NEW."orderId" AND o."supplierId" = NEW."supplierId" AND o."organizationId" = NEW."organizationId" AND o."status" IN ('sent', 'partially-received')) THEN
      RAISE EXCEPTION 'GoodsReceipt: only against a sent order of this supplier at this facility';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'checking' THEN RAISE EXCEPTION 'GoodsReceipt %: a posted or discarded receipt never changes', OLD."id"; END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."orderId", NEW."supplierId", NEW."createdById") IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."orderId", OLD."supplierId", OLD."createdById") THEN
    RAISE EXCEPTION 'GoodsReceipt %: what it is never changes', OLD."id";
  END IF;
  IF NEW."status" = 'posted' THEN
    IF NEW."number" IS NULL OR NEW."postedById" IS NULL OR NOT lab_actor_ok(NEW."postedById") THEN RAISE EXCEPTION 'GoodsReceipt %: posted with a number, by the signed-in user', OLD."id"; END IF;
    IF NOT EXISTS (SELECT 1 FROM "GoodsReceiptLine" WHERE "receiptId" = NEW."id") OR EXISTS (SELECT 1 FROM "GoodsReceiptLine" WHERE "receiptId" = NEW."id" AND "batchId" IS NULL AND "receivedQty" > 0) THEN
      RAISE EXCEPTION 'GoodsReceipt %: every received line goes into a batch', OLD."id";
    END IF;
  ELSIF NEW."status" NOT IN ('checking', 'discarded') THEN
    RAISE EXCEPTION 'GoodsReceipt %: cannot move to %', OLD."id", NEW."status";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER goods_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON "GoodsReceipt" FOR EACH ROW EXECUTE FUNCTION goods_receipt_guard();

CREATE OR REPLACE FUNCTION goods_receipt_line_guard() RETURNS trigger AS $$
DECLARE st "GoodsReceiptStatus";
BEGIN
  SELECT "status" INTO st FROM "GoodsReceipt" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."receiptId" ELSE NEW."receiptId" END);
  IF st <> 'checking' THEN RAISE EXCEPTION 'GoodsReceiptLine: a posted receipt''s lines never change'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER goods_receipt_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "GoodsReceiptLine" FOR EACH ROW EXECUTE FUNCTION goods_receipt_line_guard();

-- ───── counts: lines change only while counting; the owner / admin decides, never on their own count ─────
CREATE OR REPLACE FUNCTION stock_count_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'StockCount is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'counting' THEN RAISE EXCEPTION 'StockCount: a new count starts as counting'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('approved', 'rejected') THEN RAISE EXCEPTION 'StockCount %: a decided count never changes', OLD."id"; END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."location", NEW."createdById", NEW."createdAt") IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."location", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'StockCount %: what it is never changes', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'counting' AND NEW."status" = 'submitted')
    OR (OLD."status" = 'submitted' AND NEW."status" IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'StockCount %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF NEW."status" IN ('approved', 'rejected') AND (NEW."decidedById" IS NULL OR NEW."decidedById" = OLD."createdById" OR NOT lab_actor_ok(NEW."decidedById")) THEN
    RAISE EXCEPTION 'StockCount %: decided by the signed-in owner / admin, never the person who counted', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_count_guard BEFORE INSERT OR UPDATE OR DELETE ON "StockCount" FOR EACH ROW EXECUTE FUNCTION stock_count_guard();

CREATE OR REPLACE FUNCTION stock_count_line_guard() RETURNS trigger AS $$
DECLARE st "StockCountStatus";
BEGIN
  SELECT "status" INTO st FROM "StockCount" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."countId" ELSE NEW."countId" END);
  IF st <> 'counting' THEN RAISE EXCEPTION 'StockCountLine: lines change only while counting'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW."countId", NEW."batchId", NEW."systemQty") IS DISTINCT FROM (OLD."countId", OLD."batchId", OLD."systemQty") THEN
    RAISE EXCEPTION 'StockCountLine: the batch and its system quantity are fixed when the count starts';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_count_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "StockCountLine" FOR EACH ROW EXECUTE FUNCTION stock_count_line_guard();

-- A receive move comes from a posted goods-receipt line, an adjust from an approved count, a transfer in pairs (refId).
ALTER TABLE "StockMove" ADD CONSTRAINT stock_move_ref_kinds CHECK (
  ("kind" <> 'receive' OR "refType" IN ('seed', 'grn-line'))
  AND ("kind" <> 'transfer' OR ("refType" = 'transfer' AND "refId" IS NOT NULL)));
