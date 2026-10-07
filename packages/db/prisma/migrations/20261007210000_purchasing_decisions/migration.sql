-- External review A6: purchasing decisions 179–186 (ADR 0009 addendum).
-- 180: the receipt price tolerance, per facility — min(bp of the line at the order's cost, an amount) per line.
ALTER TABLE "Organization" ADD COLUMN "grnToleranceBp" INTEGER NOT NULL DEFAULT 200;
ALTER TABLE "Organization" ADD COLUMN "grnTolerancePaisa" INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE "Organization" ADD CONSTRAINT organization_grn_tolerance CHECK ("grnToleranceBp" BETWEEN 0 AND 1000 AND "grnTolerancePaisa" BETWEEN 0 AND 100000);

-- 181: the supplier's VAT and AIT as printed on their bill — recorded as data, not added to what is owed (frozen with
-- the receipt when it is posted: goods_receipt_guard refuses any change after checking).
ALTER TABLE "GoodsReceipt" ADD COLUMN "supplierVatPaisa" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoodsReceipt" ADD COLUMN "supplierAitPaisa" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT goods_receipt_supplier_tax CHECK ("supplierVatPaisa" >= 0 AND "supplierAitPaisa" >= 0);

-- A count still being entered when its counter's shift closes is ended: STOCK_COUNT counting → abandoned.
ALTER TYPE "StockCountStatus" ADD VALUE IF NOT EXISTS 'abandoned';

CREATE OR REPLACE FUNCTION stock_count_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'StockCount is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'counting' THEN RAISE EXCEPTION 'StockCount: a new count starts as counting'; END IF;
    -- a ward's stock is counted by a nurse of this facility, signed in
    IF NEW."location" LIKE 'ward:%' AND (NOT lab_actor_ok(NEW."createdById") OR NOT EXISTS (SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = NEW."createdById" AND r."organizationId" = NEW."organizationId" AND r."role" = 'nurse')) THEN
      RAISE EXCEPTION 'StockCount: a ward count is started by a nurse of this facility';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status"::text IN ('approved', 'rejected', 'abandoned') THEN RAISE EXCEPTION 'StockCount %: a decided or ended count never changes', OLD."id"; END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."location", NEW."createdById", NEW."createdAt") IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."location", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'StockCount %: what it is never changes', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'counting' AND NEW."status"::text IN ('submitted', 'abandoned'))
    OR (OLD."status" = 'submitted' AND NEW."status" IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'StockCount %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF NEW."status"::text = 'abandoned' THEN
    -- ended in the counter's own shift close, with the reason; nothing is decided, nothing moves
    IF NEW."decidedById" IS DISTINCT FROM OLD."createdById" OR NOT lab_actor_ok(NEW."decidedById") THEN RAISE EXCEPTION 'StockCount %: a count is ended only in its counter''s own shift close', OLD."id"; END IF;
    IF length(btrim(coalesce(NEW."decisionNote", ''))) < 10 THEN RAISE EXCEPTION 'StockCount %: an ended count says why', OLD."id"; END IF;
    IF NEW."selfApproved" THEN RAISE EXCEPTION 'StockCount %: an ended count is not approved', OLD."id"; END IF;
  ELSIF NEW."status" IN ('approved', 'rejected') THEN
    IF NEW."decidedById" IS NULL OR NOT lab_actor_ok(NEW."decidedById") THEN RAISE EXCEPTION 'StockCount %: decided by the signed-in owner / admin', OLD."id"; END IF;
    -- decision 234 (= 223): the person who counted decides only as the facility's only approver, with a note, flagged
    IF (NEW."decidedById" = OLD."createdById") <> NEW."selfApproved" THEN RAISE EXCEPTION 'StockCount %: self-approved exactly when the counter decides', OLD."id"; END IF;
    IF NEW."selfApproved" AND (facility_count_approvers(OLD."organizationId", OLD."location") <> 1 OR length(btrim(coalesce(NEW."decisionNote", ''))) < 10) THEN
      RAISE EXCEPTION 'StockCount %: never decided by the person who counted while another approver exists (alone: with a note)', OLD."id";
    END IF;
  ELSIF NEW."selfApproved" THEN RAISE EXCEPTION 'StockCount %: self-approval is recorded at the decision', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
