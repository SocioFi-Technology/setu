-- External review A6 follow-up (ADR 0009 addendum 2).
-- The PO cancel path: an order cancelled while its approval request is open withdraws the request — APPROVAL
-- requested → withdrawn, recorded with who cancelled; never "rejected" (nobody decided it).
ALTER TYPE "ApprovalStatus" ADD VALUE IF NOT EXISTS 'withdrawn';

CREATE OR REPLACE FUNCTION task_withdraw_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text = 'withdrawn' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'requested' THEN RAISE EXCEPTION 'Task %: only an open request is withdrawn', OLD."id"; END IF;
    IF NEW."decidedById" IS NULL OR NOT lab_actor_ok(NEW."decidedById") THEN RAISE EXCEPTION 'Task %: withdrawn by the signed-in user', OLD."id"; END IF;
    IF length(btrim(coalesce(NEW."decisionNote", ''))) < 10 THEN RAISE EXCEPTION 'Task %: a withdrawal says why', OLD."id"; END IF;
  END IF;
  IF OLD."status"::text = 'withdrawn' AND NEW."status" IS DISTINCT FROM OLD."status" THEN RAISE EXCEPTION 'Task %: a withdrawn request is final', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER task_withdraw_guard BEFORE UPDATE ON "Task" FOR EACH ROW EXECUTE FUNCTION task_withdraw_guard();

-- Decision 181 as the review states it: each supplier carries whether its bills show VAT included, on top, or are
-- exempt; a goods receipt keeps the flag as it was when posted, beside the amounts printed on the bill. Never computed.
ALTER TABLE "Supplier" ADD COLUMN "vatTreatment" TEXT NOT NULL DEFAULT 'included';
ALTER TABLE "Supplier" ADD CONSTRAINT supplier_vat_treatment CHECK ("vatTreatment" IN ('included', 'on-top', 'exempt'));
ALTER TABLE "GoodsReceipt" ADD COLUMN "supplierVatTreatment" TEXT;
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT goods_receipt_vat_treatment CHECK ("supplierVatTreatment" IS NULL OR "supplierVatTreatment" IN ('included', 'on-top', 'exempt'));
