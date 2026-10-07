-- Decision 321 (Kamrul 08/10/2026): a supplier that bills VAT on top is owed it — the VAT printed on the bill (as posted
-- on the goods receipt, flag "on-top") is a ledger entry of its own, `supplier-vat`, that adds to what is owed. Recorded
-- as data, never computed; whether it can be reclaimed is the accountant's question. AIT stays data (the buyer
-- withholds it).
ALTER TABLE "SupplierEntry" DROP CONSTRAINT supplier_entry_shape;
ALTER TABLE "SupplierEntry" ADD CONSTRAINT supplier_entry_shape CHECK ("amountPaisa" > 0 AND "kind" IN ('goods-received', 'debit-note', 'payment', 'supplier-vat'));

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
  -- decision 321: the VAT owed is the VAT printed on a posted receipt whose supplier bills it on top — nothing else
  IF NEW."kind" = 'supplier-vat' AND NOT EXISTS (
    SELECT 1 FROM "GoodsReceipt" g WHERE NEW."refType" = 'grn' AND g."id" = NEW."refId" AND g."status" = 'posted' AND g."supplierId" = NEW."supplierId"
      AND g."supplierVatTreatment" = 'on-top' AND NEW."amountPaisa" = g."supplierVatPaisa") THEN
    RAISE EXCEPTION 'SupplierEntry %: VAT owed equals the VAT on a posted receipt billed on top', NEW."id";
  END IF;
  IF NEW."kind" = 'payment' THEN
    IF NOT is_stock_approver(NEW."byId", NEW."organizationId") THEN RAISE EXCEPTION 'SupplierEntry %: only the owner or an admin pays a supplier', NEW."id"; END IF;
    SELECT coalesce(sum(CASE WHEN "kind" IN ('goods-received', 'supplier-vat') THEN "amountPaisa" ELSE -"amountPaisa" END), 0) INTO owed FROM "SupplierEntry" WHERE "supplierId" = NEW."supplierId";
    IF owed < 0 THEN RAISE EXCEPTION 'SupplierEntry %: more paid than owed', NEW."id"; END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
