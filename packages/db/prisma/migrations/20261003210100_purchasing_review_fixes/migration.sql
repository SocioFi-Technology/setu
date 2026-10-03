-- Pharmacy session 2 review fixes (security + money-controls reviews, ADR 0009).
ALTER TABLE "StockCountLine" ADD COLUMN "countedAt" TIMESTAMP(3);

-- One supplier invoice is posted once (a second receipt with the same bill number would bill the supplier twice).
CREATE UNIQUE INDEX "GoodsReceipt_supplier_invoice_once" ON "GoodsReceipt" ("tenantId", "supplierId", "supplierInvoiceNo")
  WHERE "status" = 'posted' AND "supplierInvoiceNo" IS NOT NULL;
-- One goods-received and at most one debit-note entry per receipt.
CREATE UNIQUE INDEX "SupplierEntry_once_per_receipt" ON "SupplierEntry" ("refId", "kind") WHERE "refType" = 'grn';

-- the owner / admin of the facility (PractitionerRole), for decisions the database re-checks
CREATE OR REPLACE FUNCTION is_stock_approver(p_user text, p_org text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = p_user AND r."organizationId" = p_org AND r."role" IN ('owner', 'admin'));
$$;

-- ───── every stock move the app writes is backed by what made it (checked at commit) ─────
-- receive: a line of a posted goods receipt, into its batch, its received quantity; transfer: exactly two legs that
-- cancel out, on the same batch number / expiry / prices; adjust: an approved count of that batch. The seed and
-- maintenance scripts run as the owner role and are not checked here.
CREATE OR REPLACE FUNCTION stock_move_backed() RETURNS trigger AS $$
DECLARE n int; total bigint; kinds int;
BEGIN
  IF current_user <> 'setu_app' THEN RETURN NULL; END IF;
  IF NEW."kind" = 'receive' THEN
    IF NOT EXISTS (SELECT 1 FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" g ON g."id" = l."receiptId"
                   WHERE NEW."refType" = 'grn-line' AND l."id" = NEW."refId" AND g."status" = 'posted' AND g."organizationId" = NEW."organizationId"
                     AND l."batchId" = NEW."batchId" AND l."receivedQty" = NEW."qty") THEN
      RAISE EXCEPTION 'StockMove %: a receive comes from a posted goods-receipt line', NEW."id";
    END IF;
  ELSIF NEW."kind" = 'transfer' THEN
    SELECT count(*), coalesce(sum(m."qty"), 0), count(DISTINCT (b."medicineKey", b."batchNo", b."expiry", b."costPaisa", b."mrpPaisa", b."vatRateBp"))
      INTO n, total, kinds FROM "StockMove" m JOIN "StockBatch" b ON b."id" = m."batchId" WHERE m."refType" = 'transfer' AND m."refId" = NEW."refId";
    IF n <> 2 OR total <> 0 OR kinds <> 1 THEN RAISE EXCEPTION 'StockMove %: a transfer is two legs of the same batch that cancel out', NEW."id"; END IF;
  ELSIF NEW."kind" = 'adjust' THEN
    IF NOT EXISTS (SELECT 1 FROM "StockCount" c JOIN "StockCountLine" l ON l."countId" = c."id"
                   WHERE NEW."refType" = 'count' AND c."id" = NEW."refId" AND c."status" = 'approved' AND c."organizationId" = NEW."organizationId" AND l."batchId" = NEW."batchId") THEN
      RAISE EXCEPTION 'StockMove %: an adjustment comes from an approved count', NEW."id";
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER stock_move_backed AFTER INSERT ON "StockMove" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_move_backed();

-- ───── the supplier ledger: same facility; receipt entries equal the posted receipt; payments by the owner / admin,
--       never leaving the supplier owed less than nothing (checked at commit) ─────
CREATE OR REPLACE FUNCTION supplier_entry_backed() RETURNS trigger AS $$
DECLARE owed bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Supplier" s WHERE s."id" = NEW."supplierId" AND s."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'SupplierEntry %: the supplier is not at this facility', NEW."id";
  END IF;
  IF NEW."kind" IN ('goods-received', 'debit-note') AND NOT EXISTS (
    SELECT 1 FROM "GoodsReceipt" g WHERE NEW."refType" = 'grn' AND g."id" = NEW."refId" AND g."status" = 'posted' AND g."supplierId" = NEW."supplierId"
      AND NEW."amountPaisa" = CASE WHEN NEW."kind" = 'goods-received' THEN g."invoicedPaisa" ELSE g."debitNotePaisa" END) THEN
    RAISE EXCEPTION 'SupplierEntry %: a receipt entry equals its posted goods receipt', NEW."id";
  END IF;
  IF NEW."kind" = 'payment' THEN
    IF NOT is_stock_approver(NEW."byId", NEW."organizationId") THEN RAISE EXCEPTION 'SupplierEntry %: only the owner or an admin pays a supplier', NEW."id"; END IF;
    SELECT coalesce(sum(CASE WHEN "kind" = 'goods-received' THEN "amountPaisa" ELSE -"amountPaisa" END), 0) INTO owed FROM "SupplierEntry" WHERE "supplierId" = NEW."supplierId";
    IF owed < 0 THEN RAISE EXCEPTION 'SupplierEntry %: more paid than owed', NEW."id"; END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER supplier_entry_backed AFTER INSERT ON "SupplierEntry" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_entry_backed();

-- ───── an order line's received quantity is what its posted receipts brought (checked at commit) ─────
CREATE OR REPLACE FUNCTION po_line_received_backed() RETURNS trigger AS $$
DECLARE got bigint;
BEGIN
  SELECT coalesce(sum(l."receivedQty"), 0) INTO got FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" g ON g."id" = l."receiptId"
    WHERE l."orderLineId" = NEW."id" AND g."status" = 'posted';
  IF got <> NEW."receivedQty" THEN RAISE EXCEPTION 'PurchaseOrderLine %: received % but posted receipts brought %', NEW."id", NEW."receivedQty", got; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER po_line_received_backed AFTER UPDATE OF "receivedQty" ON "PurchaseOrderLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION po_line_received_backed();

-- ───── goods receipts: a line belongs to the receipt's order; posting matches the lines' money and batches ─────
CREATE OR REPLACE FUNCTION goods_receipt_line_guard() RETURNS trigger AS $$
DECLARE st "GoodsReceiptStatus"; ord text;
BEGIN
  SELECT "status", "orderId" INTO st, ord FROM "GoodsReceipt" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."receiptId" ELSE NEW."receiptId" END);
  IF st <> 'checking' THEN RAISE EXCEPTION 'GoodsReceiptLine: a posted receipt''s lines never change'; END IF;
  IF TG_OP <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM "PurchaseOrderLine" o WHERE o."id" = NEW."orderLineId" AND o."orderId" = ord AND o."medicineKey" = NEW."medicineKey") THEN
    RAISE EXCEPTION 'GoodsReceiptLine: the line is not on this receipt''s order';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION goods_receipt_post_check() RETURNS trigger AS $$
DECLARE inv bigint; deb bigint;
BEGIN
  SELECT coalesce(sum("invoicedQty"::bigint * "costPaisa"), 0), coalesce(sum(("invoicedQty" - "receivedQty")::bigint * "costPaisa"), 0) INTO inv, deb
    FROM "GoodsReceiptLine" WHERE "receiptId" = NEW."id";
  IF (inv, deb) IS DISTINCT FROM (NEW."invoicedPaisa"::bigint, NEW."debitNotePaisa"::bigint) THEN RAISE EXCEPTION 'GoodsReceipt %: billed / debit note are not the sums of its lines', NEW."id"; END IF;
  IF EXISTS (SELECT 1 FROM "GoodsReceiptLine" l LEFT JOIN "StockBatch" b ON b."id" = l."batchId"
             WHERE l."receiptId" = NEW."id" AND l."receivedQty" > 0
               AND (b."id" IS NULL OR b."organizationId" <> NEW."organizationId" OR (b."medicineKey", b."batchNo", b."expiry", b."location", b."costPaisa", b."mrpPaisa", b."vatRateBp")
                    IS DISTINCT FROM (l."medicineKey", l."batchNo", l."expiry", l."location", l."costPaisa", l."mrpPaisa", l."vatRateBp"))) THEN
    RAISE EXCEPTION 'GoodsReceipt %: a line''s batch is not what was received', NEW."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER goods_receipt_post_check BEFORE UPDATE ON "GoodsReceipt" FOR EACH ROW
  WHEN (OLD."status" = 'checking' AND NEW."status" = 'posted') EXECUTE FUNCTION goods_receipt_post_check();

-- ───── a count is decided by the facility's owner / admin (not only "someone else") ─────
CREATE OR REPLACE FUNCTION stock_count_decider() RETURNS trigger AS $$
BEGIN
  IF NOT is_stock_approver(NEW."decidedById", NEW."organizationId") THEN RAISE EXCEPTION 'StockCount %: decided by the owner or an admin', NEW."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_count_decider BEFORE UPDATE ON "StockCount" FOR EACH ROW
  WHEN (OLD."status" = 'submitted' AND NEW."status" IN ('approved', 'rejected')) EXECUTE FUNCTION stock_count_decider();
