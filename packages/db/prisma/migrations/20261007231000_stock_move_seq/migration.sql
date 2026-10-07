-- External review B9: a stock count's snapshot and the moves since it are matched by a per-batch move number assigned
-- under the batch's row lock (so in commit order), not by wall-clock "at": a dispense that committed after the
-- snapshot with an earlier "at" is no longer missed on both sides.
ALTER TABLE "StockBatch" ADD COLUMN "moveSeq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StockMove" ADD COLUMN "batchSeq" INTEGER;
ALTER TABLE "StockCountLine" ADD COLUMN "sinceSeq" INTEGER;
ALTER TABLE "StockCountLine" ADD COLUMN "countedSeq" INTEGER;

-- the moves so far are numbered in the order they were recorded (history keeps its "at" order)
ALTER TABLE "StockMove" DISABLE TRIGGER stock_move_immutable;
WITH n AS (SELECT "id", row_number() OVER (PARTITION BY "batchId" ORDER BY "at", "id") AS seq FROM "StockMove")
UPDATE "StockMove" m SET "batchSeq" = n.seq FROM n WHERE n."id" = m."id";
ALTER TABLE "StockMove" ENABLE TRIGGER stock_move_immutable;
SELECT set_config('setu.stock_ledger', 'on', true);
UPDATE "StockBatch" b SET "moveSeq" = coalesce((SELECT max(m."batchSeq") FROM "StockMove" m WHERE m."batchId" = b."id"), 0);
CREATE UNIQUE INDEX "StockMove_batchId_batchSeq_key" ON "StockMove" ("batchId", "batchSeq");

CREATE OR REPLACE FUNCTION stock_move_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b RECORD;
BEGIN
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'StockMove: recorded by someone other than the signed-in user'; END IF;
  SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId" AND "tenantId" = NEW."tenantId" FOR UPDATE;
  IF NOT FOUND OR b."organizationId" <> NEW."organizationId" THEN RAISE EXCEPTION 'StockMove: the batch is not at this facility'; END IF;
  IF b."qtyOnHand" + NEW."qty" < 0 THEN RAISE EXCEPTION 'StockMove: batch % holds % — cannot take %', b."batchNo", b."qtyOnHand", -NEW."qty"; END IF;
  NEW."batchSeq" := b."moveSeq" + 1;
  PERFORM set_config('setu.stock_ledger', 'on', true);
  UPDATE "StockBatch" SET "qtyOnHand" = "qtyOnHand" + NEW."qty", "moveSeq" = "moveSeq" + 1 WHERE "id" = NEW."batchId";
  PERFORM set_config('setu.stock_ledger', 'off', true);
  RETURN NEW;
END $$;

-- the move number changes only with a move (the ledger), like the quantity
CREATE OR REPLACE FUNCTION stock_batch_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'StockBatch %: a batch is never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."qtyOnHand" <> 0 OR NEW."moveSeq" <> 0 THEN RAISE EXCEPTION 'StockBatch: a batch starts empty — stock arrives through a receive move'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."medicineKey", NEW."batchNo", NEW."expiry", NEW."location", NEW."costPaisa", NEW."mrpPaisa", NEW."vatRateBp", NEW."sample")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."medicineKey", OLD."batchNo", OLD."expiry", OLD."location", OLD."costPaisa", OLD."mrpPaisa", OLD."vatRateBp", OLD."sample") THEN
    RAISE EXCEPTION 'StockBatch %: what a batch is never changes', OLD."id";
  END IF;
  IF (NEW."qtyOnHand" <> OLD."qtyOnHand" OR NEW."moveSeq" <> OLD."moveSeq") AND coalesce(current_setting('setu.stock_ledger', true), '') <> 'on' THEN
    RAISE EXCEPTION 'StockBatch %: the quantity changes only through the stock ledger', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- the snapshot's move number is fixed with the system quantity
CREATE OR REPLACE FUNCTION stock_count_line_guard() RETURNS trigger AS $$
DECLARE st "StockCountStatus";
BEGIN
  SELECT "status" INTO st FROM "StockCount" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."countId" ELSE NEW."countId" END);
  IF st <> 'counting' THEN RAISE EXCEPTION 'StockCountLine: lines change only while counting'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW."countId", NEW."batchId", NEW."systemQty", NEW."sinceSeq") IS DISTINCT FROM (OLD."countId", OLD."batchId", OLD."systemQty", OLD."sinceSeq") THEN
    RAISE EXCEPTION 'StockCountLine: the batch and its system quantity are fixed when the count starts';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
