-- refunds_guards: the record variable `b` clashed with the table alias `b` of the transfer query (ambiguous reference).
CREATE OR REPLACE FUNCTION stock_move_backed() RETURNS trigger AS $$
DECLARE n int; total bigint; kinds int; bt RECORD; src RECORD; rs RECORD;
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
    SELECT * INTO bt FROM "StockBatch" WHERE "id" = NEW."batchId";
    IF bt."location" = 'quarantine' THEN
      SELECT * INTO rs FROM "StockResale" WHERE "transferRef" = NEW."refId";
      IF NEW."qty" > 0 OR NOT FOUND OR rs."fromBatchId" <> NEW."batchId" OR rs."qty" <> -NEW."qty" OR rs."organizationId" <> NEW."organizationId"
         OR NOT EXISTS (SELECT 1 FROM "StockMove" m JOIN "StockBatch" t ON t."id" = m."batchId" WHERE m."refType" = 'transfer' AND m."refId" = NEW."refId" AND m."batchId" = rs."toBatchId" AND t."location" = 'counter') THEN
        RAISE EXCEPTION 'StockMove %: returned stock leaves quarantine only for the counter, on a resale decision', NEW."id";
      END IF;
    END IF;
  ELSIF NEW."kind" = 'adjust' THEN
    IF NOT EXISTS (SELECT 1 FROM "StockCount" c JOIN "StockCountLine" l ON l."countId" = c."id"
                   WHERE NEW."refType" = 'count' AND c."id" = NEW."refId" AND c."status" = 'approved' AND c."organizationId" = NEW."organizationId" AND l."batchId" = NEW."batchId") THEN
      RAISE EXCEPTION 'StockMove %: an adjustment comes from an approved count', NEW."id";
    END IF;
  ELSIF NEW."kind" = 'return' THEN
    SELECT * INTO bt FROM "StockBatch" WHERE "id" = NEW."batchId";
    SELECT sb.* INTO src FROM "RefundLine" l JOIN "Refund" x ON x."id" = l."refundId" JOIN "ChargeItem" ci ON ci."id" = l."chargeItemId" JOIN "StockBatch" sb ON sb."id" = ci."batchId"
      WHERE NEW."refType" = 'refund-line' AND l."id" = NEW."refId" AND l."units" = NEW."qty" AND x."status" IN ('approved', 'paid') AND x."organizationId" = NEW."organizationId";
    IF NOT FOUND OR bt."location" <> 'quarantine'
       OR (bt."medicineKey", bt."batchNo", bt."expiry", bt."costPaisa", bt."mrpPaisa", bt."vatRateBp") IS DISTINCT FROM (src."medicineKey", src."batchNo", src."expiry", src."costPaisa", src."mrpPaisa", src."vatRateBp") THEN
      RAISE EXCEPTION 'StockMove %: a return comes into quarantine from a refund line, the units it names', NEW."id";
    END IF;
    IF (SELECT count(*) FROM "StockMove" WHERE "refType" = 'refund-line' AND "refId" = NEW."refId") <> 1 THEN
      RAISE EXCEPTION 'StockMove %: a refund line''s medicine comes back once', NEW."id";
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
