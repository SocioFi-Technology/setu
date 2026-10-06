-- ADR 0017 guards (slice B7–B9): the IPD running bill, deposits on its draft, deposit receipts, the admission's package
-- and discharge, the discharge and its six steps, bed-class rates and packages, the bed-day census targets.

-- ───── bill lines ─────
-- A credit line (creditOfId set) has a negative quantity and mirrors its original; every other line as before.
ALTER TABLE "ChargeItem" DROP CONSTRAINT charge_item_amounts;
ALTER TABLE "ChargeItem" ADD CONSTRAINT charge_item_amounts CHECK (
  (("qty" >= 1 AND "qty" <= 999) OR ("creditOfId" IS NOT NULL AND "qty" <= -1 AND "qty" >= -999))
  AND ("unitPaisa" IS NULL OR "unitPaisa" >= 0) AND "vatRateBp" >= 0 AND "vatRateBp" <= 10000
  AND "grossPaisa" = coalesce("unitPaisa", 0) * "qty"
  AND (("creditOfId" IS NULL AND "discountPaisa" >= 0 AND "discountPaisa" <= "grossPaisa") OR ("creditOfId" IS NOT NULL AND "discountPaisa" = 0))
  AND "netPaisa" = "grossPaisa" - "discountPaisa"
  AND (("creditOfId" IS NULL AND "vatPaisa" >= 0) OR ("creditOfId" IS NOT NULL AND "vatPaisa" <= 0))
  AND "totalPaisa" = "netPaisa" + "vatPaisa");
ALTER TABLE "ChargeItem" DROP CONSTRAINT charge_item_medicine;
ALTER TABLE "ChargeItem" ADD CONSTRAINT charge_item_medicine CHECK (
  ("source" IN ('dispense', 'sale', 'stock')) = ("batchId" IS NOT NULL AND "medicineKey" IS NOT NULL AND "unitPaisa" IS NOT NULL));
ALTER TABLE "ChargeItem" ADD CONSTRAINT charge_item_ipd_tag CHECK ("tag" IS NULL OR "tag" IN ('package', 'included', 'excluded'));
ALTER TABLE "ChargeItem" ADD CONSTRAINT charge_item_superseded_shape CHECK (
  ("supersededById" IS NULL) = ("supersededAt" IS NULL) AND ("supersededById" IS NULL) = ("supersededReason" IS NULL)
  AND NOT ("supersededById" IS NOT NULL AND "creditedById" IS NOT NULL));
-- One live line per key on a bill (credit lines carry their own `credit:` keys and may repeat over time).
CREATE UNIQUE INDEX "ChargeItem_one_live_key" ON "ChargeItem"("invoiceId", "key")
  WHERE "key" IS NOT NULL AND "creditOfId" IS NULL AND "supersededById" IS NULL AND "creditedById" IS NULL;

CREATE OR REPLACE FUNCTION charge_item_guard() RETURNS trigger AS $$
DECLARE inv RECORD; orig RECORD;
BEGIN
  SELECT "status", "kind" INTO inv FROM "Invoice" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END);
  IF inv."status" IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'ChargeItem: the bill is % — lines change only in a draft', inv."status"; END IF;
  IF TG_OP = 'UPDATE' AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" THEN RAISE EXCEPTION 'ChargeItem: a line cannot move to another bill'; END IF;
  IF inv."kind" = 'ipd' THEN
    -- ADR 0017: an IPD line is never removed or edited — it is superseded (re-priced) or credited (no longer wanted)
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ChargeItem %: a line of an IPD bill is never removed — it is superseded or credited', OLD."id"; END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW."key" IS NULL OR NEW."tag" IS NULL THEN RAISE EXCEPTION 'ChargeItem: an IPD line has a source key and a tag'; END IF;
      IF NEW."supersededById" IS NOT NULL OR NEW."creditedById" IS NOT NULL THEN RAISE EXCEPTION 'ChargeItem: a new line is live'; END IF;
      IF NEW."discountPaisa" <> 0 THEN RAISE EXCEPTION 'ChargeItem: an IPD line carries no discount (the final bill does)'; END IF;
      IF NEW."tag" = 'included' AND NEW."unitPaisa" IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'ChargeItem: an included line is ৳0'; END IF;
      IF (NEW."tag" = 'package') <> (NEW."source" = 'package') THEN RAISE EXCEPTION 'ChargeItem: only the package line is tagged package'; END IF;
      IF NEW."creditOfId" IS NOT NULL THEN
        SELECT * INTO orig FROM "ChargeItem" WHERE "id" = NEW."creditOfId";
        IF NOT FOUND OR orig."invoiceId" <> NEW."invoiceId" OR orig."creditOfId" IS NOT NULL OR orig."supersededById" IS NOT NULL OR orig."creditedById" IS NOT NULL
           OR NEW."key" <> 'credit:' || orig."key" OR NEW."qty" <> -orig."qty" OR NEW."unitPaisa" IS DISTINCT FROM orig."unitPaisa"
           OR NEW."vatRateBp" <> orig."vatRateBp" OR NEW."tag" <> orig."tag" OR NEW."source" <> orig."source" THEN
          RAISE EXCEPTION 'ChargeItem: a credit line mirrors a live line of the same bill';
        END IF;
      ELSIF NEW."key" LIKE 'credit:%' THEN RAISE EXCEPTION 'ChargeItem: a credit key needs the line it credits';
      END IF;
      RETURN NEW;
    END IF;
    -- UPDATE: only the supersession or the credit is recorded, once
    IF (to_jsonb(NEW) - ARRAY['supersededById', 'supersededAt', 'supersededReason', 'creditedById']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['supersededById', 'supersededAt', 'supersededReason', 'creditedById']) THEN
      RAISE EXCEPTION 'ChargeItem %: an IPD line is never edited — supersede or credit it', OLD."id";
    END IF;
    IF (OLD."supersededById" IS NOT NULL AND (NEW."supersededById", NEW."supersededAt", NEW."supersededReason") IS DISTINCT FROM (OLD."supersededById", OLD."supersededAt", OLD."supersededReason"))
       OR (OLD."creditedById" IS NOT NULL AND NEW."creditedById" IS DISTINCT FROM OLD."creditedById") THEN
      RAISE EXCEPTION 'ChargeItem %: a supersession or a credit is recorded once', OLD."id";
    END IF;
    IF OLD."creditOfId" IS NOT NULL AND (NEW."supersededById" IS NOT NULL OR NEW."creditedById" IS NOT NULL) THEN RAISE EXCEPTION 'ChargeItem %: a credit line stays as it is', OLD."id"; END IF;
    RETURN NEW;
  END IF;
  -- other bills (ADR 0009 / decision 98)
  IF TG_OP <> 'DELETE' AND (NEW."key" IS NOT NULL OR NEW."tag" IS NOT NULL OR NEW."supersededById" IS NOT NULL OR NEW."creditOfId" IS NOT NULL OR NEW."creditedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'ChargeItem: keys, tags, supersession and credit lines are for the IPD bill';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."addedById" IS NULL THEN RAISE EXCEPTION 'ChargeItem: a line records who added it'; END IF;
  IF TG_OP <> 'DELETE' AND NEW."notBilledTaskId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."notBilledTaskId" IS DISTINCT FROM OLD."notBilledTaskId") THEN
    IF NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = NEW."notBilledTaskId" AND t."kind" = 'bill-elsewhere' AND t."status" = 'approved'
                     AND t."focusId" = NEW."invoiceId" AND t."detail"->>'lineId' = NEW."id") THEN
      RAISE EXCEPTION 'ChargeItem %: "not billed here" needs an approved bill-elsewhere approval for this line', NEW."id";
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION charge_item_kind_guard() RETURNS trigger AS $$
DECLARE k "InvoiceKind";
BEGIN
  SELECT "kind" INTO k FROM "Invoice" WHERE "id" = NEW."invoiceId";
  IF k = 'ipd' THEN
    IF NEW."source" NOT IN ('package', 'bed-day', 'order', 'stock', 'desk') THEN RAISE EXCEPTION 'ChargeItem: an IPD bill holds package, bed-day, order, stock and desk lines'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."source" IN ('package', 'bed-day', 'stock') THEN RAISE EXCEPTION 'ChargeItem: % lines belong on the IPD bill', NEW."source"; END IF;
  IF NEW."source" = 'dispense' AND k <> 'pharmacy' THEN RAISE EXCEPTION 'ChargeItem: a dispense line belongs on the visit''s pharmacy bill'; END IF;
  IF NEW."source" = 'sale' AND k <> 'otc' THEN RAISE EXCEPTION 'ChargeItem: a sale line belongs on an over-the-counter bill'; END IF;
  IF NEW."source" NOT IN ('dispense', 'sale') AND k <> 'opd' THEN RAISE EXCEPTION 'ChargeItem: a pharmacy bill holds medicine lines only'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Ward stock on the IPD bill: the batch is this medicine at this facility, priced at its MRP and VAT (৳0 when the
-- package includes it). A stock line of a dose / an opened vial follows the stock that record drew.
CREATE OR REPLACE FUNCTION charge_item_medicine_guard() RETURNS trigger AS $$
DECLARE b RECORD; inv RECORD; d RECORD; moved bigint;
BEGIN
  IF NEW."source" NOT IN ('dispense', 'sale', 'stock') THEN RETURN NEW; END IF;
  SELECT * INTO inv FROM "Invoice" WHERE "id" = NEW."invoiceId";
  SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR b."organizationId" <> inv."organizationId" OR b."medicineKey" <> NEW."medicineKey" THEN
    RAISE EXCEPTION 'ChargeItem: the batch is not this medicine at this facility';
  END IF;
  IF NEW."source" = 'stock' THEN
    IF NEW."vatRateBp" <> b."vatRateBp" OR NOT (NEW."unitPaisa" = b."mrpPaisa" OR (NEW."tag" = 'included' AND NEW."unitPaisa" = 0)) THEN
      RAISE EXCEPTION 'ChargeItem: ward stock is priced at its batch''s MRP and VAT (or ৳0 in the package)';
    END IF;
    IF TG_OP = 'INSERT' AND NEW."creditOfId" IS NULL THEN
      SELECT coalesce(sum(-m."qty"), 0) INTO moved FROM "StockMove" m
        WHERE m."batchId" = NEW."batchId" AND m."refId" = NEW."sourceId" AND m."refType" IN ('administration', 'vial-open', 'dose-error');
      IF moved <> NEW."qty" THEN RAISE EXCEPTION 'ChargeItem: the record drew % from the batch, the line says %', moved, NEW."qty"; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."unitPaisa" <> b."mrpPaisa" OR NEW."vatRateBp" <> b."vatRateBp" THEN
    RAISE EXCEPTION 'ChargeItem: a medicine line is priced at its batch''s MRP and VAT';
  END IF;
  IF NEW."source" = 'dispense' AND TG_OP = 'INSERT' THEN
    SELECT * INTO d FROM "MedicationDispense" WHERE "id" = NEW."sourceId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND OR d."action" <> 'dispense' OR d."medicineKey" <> NEW."medicineKey" OR d."qty" <> NEW."qty"
       OR d."invoiceId" IS DISTINCT FROM NEW."invoiceId" OR d."encounterId" IS DISTINCT FROM inv."encounterId" THEN
      RAISE EXCEPTION 'ChargeItem: a dispense line follows its dispense record';
    END IF;
    SELECT coalesce(sum("qty"), 0) INTO moved FROM "StockMove" WHERE "refType" = 'dispense' AND "refId" = d."id" AND "batchId" = NEW."batchId";
    IF moved <> -NEW."qty" THEN RAISE EXCEPTION 'ChargeItem: the dispense took % from the batch, the line says %', -moved, NEW."qty"; END IF;
  END IF;
  IF NEW."source" = 'dispense' AND TG_OP = 'UPDATE'
     AND (NEW."qty", NEW."batchId", NEW."medicineKey", NEW."sourceId", NEW."unitPaisa") IS DISTINCT FROM (OLD."qty", OLD."batchId", OLD."medicineKey", OLD."sourceId", OLD."unitPaisa") THEN
    RAISE EXCEPTION 'ChargeItem: a dispense line is what was given — it is not edited';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- At commit: a supersession points at a newer line with the same key on the same bill; a credit pairs both ways; the
-- IPD draft's totals are the sums of its lines that are not superseded.
CREATE OR REPLACE FUNCTION ipd_bill_consistent(inv_id text) RETURNS void AS $$
DECLARE inv RECORD; sums RECORD; bad text;
BEGIN
  SELECT * INTO inv FROM "Invoice" WHERE "id" = inv_id;
  IF NOT FOUND OR inv."kind" <> 'ipd' THEN RETURN; END IF;
  SELECT c."id" INTO bad FROM "ChargeItem" c LEFT JOIN "ChargeItem" n ON n."id" = c."supersededById"
    WHERE c."invoiceId" = inv_id AND c."supersededById" IS NOT NULL AND (n."id" IS NULL OR n."invoiceId" <> inv_id OR n."key" IS DISTINCT FROM c."key" OR n."createdAt" < c."createdAt" OR n."creditOfId" IS NOT NULL) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ChargeItem %: superseded by a line that is not its newer self', bad; END IF;
  SELECT c."id" INTO bad FROM "ChargeItem" c LEFT JOIN "ChargeItem" r ON r."id" = c."creditedById"
    WHERE c."invoiceId" = inv_id AND c."creditedById" IS NOT NULL AND (r."id" IS NULL OR r."creditOfId" IS DISTINCT FROM c."id") LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ChargeItem %: credited by a line that does not credit it', bad; END IF;
  SELECT r."id" INTO bad FROM "ChargeItem" r LEFT JOIN "ChargeItem" c ON c."id" = r."creditOfId"
    WHERE r."invoiceId" = inv_id AND r."creditOfId" IS NOT NULL AND (c."id" IS NULL OR c."creditedById" IS DISTINCT FROM r."id") LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ChargeItem %: a credit line whose original does not name it', bad; END IF;
  IF inv."status" = 'draft' THEN
    SELECT coalesce(sum("grossPaisa"), 0) AS g, coalesce(sum("netPaisa"), 0) AS n, coalesce(sum("vatPaisa"), 0) AS v, coalesce(sum("totalPaisa"), 0) AS t
      INTO sums FROM "ChargeItem" WHERE "invoiceId" = inv_id AND "supersededById" IS NULL;
    IF (sums.g, sums.n, sums.v, sums.t) IS DISTINCT FROM (inv."subtotalPaisa"::bigint, inv."netPaisa"::bigint, inv."vatPaisa"::bigint, inv."totalPaisa"::bigint) OR inv."discountPaisa" <> 0 THEN
      RAISE EXCEPTION 'Invoice %: the running totals are not the sums of its live lines', inv_id;
    END IF;
  END IF;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION charge_item_ipd_consistent() RETURNS trigger AS $$
BEGIN PERFORM ipd_bill_consistent(NEW."invoiceId"); RETURN NULL; END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER charge_item_ipd_consistent AFTER INSERT OR UPDATE ON "ChargeItem" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION charge_item_ipd_consistent();
CREATE OR REPLACE FUNCTION invoice_ipd_consistent() RETURNS trigger AS $$
BEGIN IF NEW."kind" = 'ipd' THEN PERFORM ipd_bill_consistent(NEW."id"); END IF; RETURN NULL; END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_ipd_consistent AFTER UPDATE ON "Invoice" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_ipd_consistent();

-- ───── the bill: issue sums the live lines; deposits on the IPD draft ─────
CREATE OR REPLACE FUNCTION invoice_guard() RETURNS trigger AS $$
DECLARE
  sums record;
  n_lines int;
  n_unpriced int;
  paid int;
  refunded bigint;
  credited bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invoice is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' THEN RAISE EXCEPTION 'Invoice: a new bill starts as a draft'; END IF;
    IF NEW."refundedPaisa" <> 0 OR NEW."creditedPaisa" <> 0 THEN RAISE EXCEPTION 'Invoice: a new bill has nothing refunded or credited'; END IF;
    RETURN NEW;
  END IF;

  -- Confirmed money on the bill is always the sum of its confirmed payments (on an IPD draft: the deposits, ADR 0017).
  SELECT coalesce(sum("amountPaisa"), 0) INTO paid FROM "Payment" WHERE "invoiceId" = NEW."id" AND "status" = 'confirmed';
  IF NEW."paidPaisa" <> paid THEN RAISE EXCEPTION 'Invoice %: paid % is not the sum of confirmed payments %', NEW."id", NEW."paidPaisa", paid; END IF;
  IF NEW."paidPaisa" < OLD."paidPaisa" THEN RAISE EXCEPTION 'Invoice %: paid money never goes down', OLD."id"; END IF;
  -- ADR 0013: refunded money is what its bill refunds paid out, never more than was paid, never going down.
  SELECT coalesce(sum(x."amountPaisa"), 0) INTO refunded FROM "RefundAllocation" x JOIN "Refund" y ON y."id" = x."refundId"
    WHERE y."invoiceId" = NEW."id" AND y."source" = 'bill' AND x."status" = 'paid';
  IF NEW."refundedPaisa" <> refunded THEN RAISE EXCEPTION 'Invoice %: refunded % is not what its refunds paid out %', NEW."id", NEW."refundedPaisa", refunded; END IF;
  IF NEW."refundedPaisa" > NEW."paidPaisa" OR NEW."refundedPaisa" < OLD."refundedPaisa" THEN RAISE EXCEPTION 'Invoice %: refunded money is within what was paid and never goes down', NEW."id"; END IF;
  -- decision 221: credited = its recorded returns without refund; never goes down
  SELECT coalesce(sum("creditPaisa"), 0) INTO credited FROM "Refund" WHERE "invoiceId" = NEW."id" AND "kind" = 'return' AND "status" = 'paid';
  IF NEW."creditedPaisa" <> credited OR NEW."creditedPaisa" < OLD."creditedPaisa" THEN RAISE EXCEPTION 'Invoice %: credited % is not its recorded returns %', NEW."id", NEW."creditedPaisa", credited; END IF;

  -- A voided bill is frozen; only its replacement may be recorded, once (ADR 0005).
  IF OLD."status" = 'entered-in-error' THEN
    IF OLD."replacedById" IS NULL AND NEW."replacedById" IS NOT NULL AND invoice_replacement_ok(OLD, NEW."replacedById")
       AND (to_jsonb(NEW) - 'replacedById') = (to_jsonb(OLD) - 'replacedById') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Invoice %: a voided bill is never changed', OLD."id";
  END IF;

  IF NEW."status" = 'entered-in-error' THEN
    IF OLD."status" NOT IN ('draft', 'issued', 'partially-paid', 'balanced') THEN RAISE EXCEPTION 'Invoice %: a % bill cannot be voided', OLD."id", OLD."status"; END IF;
    IF paid <> NEW."refundedPaisa" THEN RAISE EXCEPTION 'Invoice %: confirmed money is on the bill — it cannot be voided', OLD."id"; END IF;
    IF EXISTS (SELECT 1 FROM "Refund" WHERE "invoiceId" = NEW."id" AND "status" IN ('requested', 'approved')) THEN
      RAISE EXCEPTION 'Invoice %: a refund is open on the bill — decide it first', OLD."id";
    END IF;
    IF EXISTS (SELECT 1 FROM "ChargeItem" c WHERE c."invoiceId" = NEW."id" AND (c."source" = 'dispense' OR (c."source" = 'sale' AND OLD."status" <> 'draft')) AND c."qty" >
                 coalesce((SELECT sum(l."units") FROM "RefundLine" l JOIN "Refund" y ON y."id" = l."refundId" WHERE l."chargeItemId" = c."id" AND y."status" = 'paid'), 0)) THEN
      RAISE EXCEPTION 'Invoice %: medicine on the bill has been given — it cannot be voided until it is returned', OLD."id";
    END IF;
    IF EXISTS (SELECT 1 FROM "Payment" WHERE "invoiceId" = NEW."id" AND "status" IN ('initiated', 'link-sent', 'waiting-customer')) THEN
      RAISE EXCEPTION 'Invoice %: a payment link is pending — cancel it first', OLD."id";
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'statusAt', 'voidReason', 'voidedById', 'voidedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'statusAt', 'voidReason', 'voidedById', 'voidedAt']) THEN
      RAISE EXCEPTION 'Invoice %: voiding changes nothing else on the bill', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'draft' THEN
    IF NEW."status" = 'draft' THEN RETURN NEW; END IF;
    IF NEW."status" <> 'issued' THEN RAISE EXCEPTION 'Invoice %: a draft can only be issued or voided', OLD."id"; END IF;
    IF EXISTS (SELECT 1 FROM "Task" WHERE "focusId" = NEW."id" AND "kind" IN ('discount-approval', 'bill-elsewhere') AND "status" = 'requested') THEN
      RAISE EXCEPTION 'Invoice %: an approval is still requested on this bill', OLD."id";
    END IF;
    -- ADR 0017: the lines that count are the ones not superseded
    SELECT count(*), count(*) FILTER (WHERE "unitPaisa" IS NULL AND "notBilledTaskId" IS NULL) INTO n_lines, n_unpriced FROM "ChargeItem" WHERE "invoiceId" = NEW."id" AND "supersededById" IS NULL;
    IF n_lines = 0 THEN RAISE EXCEPTION 'Invoice %: no lines', OLD."id"; END IF;
    IF n_unpriced > 0 THEN RAISE EXCEPTION 'Invoice %: % line(s) have no price', OLD."id", n_unpriced; END IF;
    SELECT sum("grossPaisa") AS g, sum("discountPaisa") AS d, sum("netPaisa") AS n, sum("vatPaisa") AS v, sum("totalPaisa") AS t
      INTO sums FROM "ChargeItem" WHERE "invoiceId" = NEW."id" AND "supersededById" IS NULL;
    IF (sums.g, sums.d, sums.n, sums.v, sums.t) IS DISTINCT FROM
       (NEW."subtotalPaisa"::bigint, NEW."discountPaisa"::bigint, NEW."netPaisa"::bigint, NEW."vatPaisa"::bigint, NEW."totalPaisa"::bigint) THEN
      RAISE EXCEPTION 'Invoice %: totals are not the sums of the line paisa', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY['status', 'paidPaisa', 'refundedPaisa', 'creditedPaisa', 'statusAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'paidPaisa', 'refundedPaisa', 'creditedPaisa', 'statusAt']) THEN
    RAISE EXCEPTION 'Invoice %: an issued bill is never edited', OLD."id";
  END IF;
  IF NOT (
       (OLD."status" = 'issued' AND NEW."status" IN ('issued', 'partially-paid', 'balanced'))
    OR (OLD."status" = 'partially-paid' AND NEW."status" IN ('partially-paid', 'balanced'))
    OR (OLD."status" = 'balanced' AND NEW."status" = 'balanced')
  ) THEN
    RAISE EXCEPTION 'Invoice %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Deposits (Kamrul, decision 2): paying against a draft bill is an IPD-only exception.
CREATE OR REPLACE FUNCTION payment_guard() RETURNS trigger AS $$
DECLARE inv RECORD; payable boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment is never deleted'; END IF;
  SELECT "status", "kind" INTO inv FROM "Invoice" WHERE "id" = NEW."invoiceId";
  payable := inv."status" IN ('issued', 'partially-paid') OR (inv."kind" = 'ipd' AND inv."status" = 'draft');
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'initiated' THEN RAISE EXCEPTION 'Payment: a new payment starts as initiated (PAYMENT machine)'; END IF;
    IF NOT coalesce(payable, false) THEN
      RAISE EXCEPTION 'Payment: the bill is % — payments are taken only on an issued bill (or as a deposit on a running IPD bill)', inv."status";
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'confirmed' THEN RAISE EXCEPTION 'Payment %: a confirmed payment is never changed', OLD."id"; END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."invoiceId", NEW."patientId", NEW."method", NEW."amountPaisa",
      NEW."tenderedPaisa", NEW."changePaisa", NEW."provider", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."organizationId", OLD."invoiceId", OLD."patientId", OLD."method", OLD."amountPaisa",
      OLD."tenderedPaisa", OLD."changePaisa", OLD."provider", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'Payment %: amount, method and bill never change', OLD."id";
  END IF;
  IF NOT (
       (OLD."status" = 'initiated' AND NEW."status" IN ('initiated', 'link-sent', 'confirmed', 'failed'))
    OR (OLD."status" = 'link-sent' AND NEW."status" IN ('link-sent', 'waiting-customer', 'confirmed', 'failed'))
    OR (OLD."status" = 'waiting-customer' AND NEW."status" IN ('waiting-customer', 'confirmed', 'failed'))
    OR (OLD."status" = 'failed' AND NEW."status" = 'initiated' AND NEW."attempt" = OLD."attempt" + 1)
  ) THEN
    RAISE EXCEPTION 'Payment %: cannot move from % to % (PAYMENT machine)', OLD."id", OLD."status", NEW."status";
  END IF;
  IF OLD."status" = 'failed' AND NOT coalesce(payable, false) THEN
    RAISE EXCEPTION 'Payment %: the bill is % — a failed payment is not retried', OLD."id", inv."status";
  END IF;
  IF NEW."status" <> 'initiated' AND NEW."attempt" <> OLD."attempt" THEN RAISE EXCEPTION 'Payment %: attempt changes only on retry', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- A deposit receipt is a money receipt for one confirmed payment on an IPD bill: that amount, nothing due.
ALTER TABLE "Receipt" ADD CONSTRAINT receipt_kind CHECK ("kind" IN ('bill', 'deposit') AND ("kind" = 'deposit') = ("paymentId" IS NOT NULL));
CREATE OR REPLACE FUNCTION receipt_deposit_guard() RETURNS trigger AS $$
DECLARE p RECORD; k "InvoiceKind";
BEGIN
  IF NEW."kind" <> 'deposit' THEN RETURN NEW; END IF;
  SELECT * INTO p FROM "Payment" WHERE "id" = NEW."paymentId";
  SELECT "kind" INTO k FROM "Invoice" WHERE "id" = NEW."invoiceId";
  IF NOT FOUND OR p."id" IS NULL OR p."invoiceId" <> NEW."invoiceId" OR p."status" <> 'confirmed' OR k <> 'ipd' THEN
    RAISE EXCEPTION 'Receipt: a deposit receipt is for a confirmed payment on this IPD bill';
  END IF;
  IF NEW."paidPaisa" <> p."amountPaisa" OR NEW."totalPaisa" <> p."amountPaisa" OR NEW."duePaisa" <> 0 OR NEW."creditedPaisa" <> 0 OR NEW."number" NOT LIKE 'DR/%' THEN
    RAISE EXCEPTION 'Receipt: a deposit receipt shows that payment''s amount, nothing due, numbered DR/yy/nnnn';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER receipt_deposit_guard BEFORE INSERT ON "Receipt" FOR EACH ROW EXECUTE FUNCTION receipt_deposit_guard();

-- ───── admission: the package once; discharged with a completed discharge ─────
CREATE OR REPLACE FUNCTION admission_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Admission %: never deleted', OLD."id"; END IF;
  IF NEW."source" NOT IN ('opd', 'er', 'direct') OR NEW."status" NOT IN ('requested', 'admitted', 'cancelled', 'discharged') THEN RAISE EXCEPTION 'Admission: unknown source or status'; END IF;
  IF TG_OP = 'INSERT' AND NOT lab_actor_ok(NEW."requestedById") THEN RAISE EXCEPTION 'Admission: requested by the signed-in user'; END IF;
  IF TG_OP = 'INSERT' AND NEW."status" = 'discharged' THEN RAISE EXCEPTION 'Admission: a new admission is not discharged'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('cancelled', 'discharged') AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Admission %: % is final', OLD."id", OLD."status"; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'admitted' AND NEW."status" NOT IN ('admitted', 'discharged') THEN RAISE EXCEPTION 'Admission %: an admitted patient is only discharged', OLD."id"; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'requested' AND NEW."status" = 'discharged' THEN RAISE EXCEPTION 'Admission %: never admitted', OLD."id"; END IF;
  IF NEW."status" = 'admitted' AND (TG_OP = 'INSERT' OR OLD."status" <> 'admitted') AND (NEW."encounterId" IS NULL OR NEW."number" IS NULL OR NEW."admittedAt" IS NULL OR NOT lab_actor_ok(NEW."admittedById")) THEN
    RAISE EXCEPTION 'Admission %: admitted = encounter, number, time and who', NEW."id";
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'admitted' THEN
    IF (NEW."encounterId", NEW."number", NEW."admittedAt", NEW."admittedById", NEW."patientId", NEW."source") IS DISTINCT FROM (OLD."encounterId", OLD."number", OLD."admittedAt", OLD."admittedById", OLD."patientId", OLD."source") THEN
      RAISE EXCEPTION 'Admission %: what was admitted never changes', OLD."id";
    END IF;
    IF OLD."invoiceId" IS NOT NULL AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" THEN RAISE EXCEPTION 'Admission %: the IPD bill never changes', OLD."id"; END IF;
    -- ADR 0017: the package is applied once (snapshot, who, when) and never changed
    IF OLD."packageSnapshot" IS NOT NULL AND (NEW."packageId", NEW."packageSnapshot", NEW."packageAppliedById", NEW."packageAppliedAt") IS DISTINCT FROM (OLD."packageId", OLD."packageSnapshot", OLD."packageAppliedById", OLD."packageAppliedAt") THEN
      RAISE EXCEPTION 'Admission %: the package is applied once', OLD."id";
    END IF;
    IF OLD."packageSnapshot" IS NULL AND NEW."packageSnapshot" IS NOT NULL AND (NEW."packageId" IS NULL OR NEW."packageAppliedAt" IS NULL OR NOT lab_actor_ok(NEW."packageAppliedById")) THEN
      RAISE EXCEPTION 'Admission %: a package records which, who and when', OLD."id";
    END IF;
    IF NEW."status" = 'discharged' THEN
      IF NEW."dischargedAt" IS NULL OR NOT lab_actor_ok(NEW."dischargedById") THEN RAISE EXCEPTION 'Admission %: discharged = time and who', OLD."id"; END IF;
      IF NOT EXISTS (SELECT 1 FROM "Discharge" d WHERE d."admissionId" = NEW."id" AND d."status" = 'completed') THEN RAISE EXCEPTION 'Admission %: discharged only through the checklist', OLD."id"; END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."packageSnapshot" IS NOT NULL AND (NEW."packageId" IS NULL OR NEW."packageAppliedAt" IS NULL OR NOT lab_actor_ok(NEW."packageAppliedById")) THEN
    RAISE EXCEPTION 'Admission: a package records which, who and when';
  END IF;
  IF NEW."status" IN ('requested', 'cancelled') AND (NEW."encounterId" IS NOT NULL OR NEW."invoiceId" IS NOT NULL) THEN RAISE EXCEPTION 'Admission %: only an admitted admission has an encounter and a bill', NEW."id"; END IF;
  IF NEW."status" <> 'discharged' AND (NEW."dischargedAt" IS NOT NULL OR NEW."dischargedById" IS NOT NULL) THEN RAISE EXCEPTION 'Admission %: not discharged', NEW."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ───── the discharge and its steps ─────
CREATE UNIQUE INDEX "Discharge_one_live_per_admission" ON "Discharge"("tenantId", "admissionId") WHERE "status" IN ('ordered', 'completed');
ALTER TABLE "Discharge" ADD CONSTRAINT discharge_shape CHECK (
  "status" IN ('ordered', 'completed', 'cancelled') AND length(btrim("advice")) >= 10
  AND ("status" = 'cancelled') = ("cancelledAt" IS NOT NULL) AND ("status" = 'cancelled') = ("cancelledById" IS NOT NULL)
  AND ("status" <> 'cancelled' OR length(btrim(coalesce("cancelReason", ''))) >= 10)
  AND ("status" = 'completed') = ("completedAt" IS NOT NULL));
ALTER TABLE "DischargeStep" ADD CONSTRAINT discharge_step_shape CHECK (
  "key" IN ('order', 'summary', 'pharmacy', 'final-bill', 'payment', 'bed-release') AND "status" IN ('waiting', 'in-progress', 'done')
  AND ("status" = 'waiting') = ("startedAt" IS NULL) AND ("status" = 'done') = ("doneAt" IS NOT NULL) AND ("status" = 'done') = ("doneById" IS NOT NULL)
  AND ("takenById" IS NULL) = ("takenAt" IS NULL) AND ("remindedById" IS NULL) = ("remindedAt" IS NULL) AND "reminders" >= 0
  AND (NOT "byHand" OR "key" IN ('summary', 'final-bill', 'payment')));

CREATE OR REPLACE FUNCTION discharge_guard() RETURNS trigger AS $$
DECLARE a RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Discharge %: never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO a FROM "Admission" WHERE "id" = NEW."admissionId";
    IF NOT FOUND OR a."status" <> 'admitted' OR a."encounterId" IS DISTINCT FROM NEW."encounterId" OR a."patientId" <> NEW."patientId" OR a."organizationId" <> NEW."organizationId" THEN
      RAISE EXCEPTION 'Discharge: for an admitted patient of this facility';
    END IF;
    IF NEW."status" <> 'ordered' OR NOT lab_actor_ok(NEW."orderedById") THEN RAISE EXCEPTION 'Discharge: ordered by the signed-in doctor'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelledById', 'cancelledAt', 'cancelReason', 'completedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancelledById', 'cancelledAt', 'cancelReason', 'completedAt']) THEN
    RAISE EXCEPTION 'Discharge %: the order never changes — cancel it and order again', OLD."id";
  END IF;
  IF OLD."status" <> 'ordered' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Discharge %: % is final', OLD."id", OLD."status"; END IF;
  IF NEW."status" = 'cancelled' AND OLD."status" = 'ordered' THEN
    IF NOT lab_actor_ok(NEW."cancelledById") THEN RAISE EXCEPTION 'Discharge %: cancelled by the signed-in doctor', OLD."id"; END IF;
    IF EXISTS (SELECT 1 FROM "DischargeStep" WHERE "dischargeId" = OLD."id" AND "key" = 'bed-release' AND "status" = 'done') THEN RAISE EXCEPTION 'Discharge %: the bed was released', OLD."id"; END IF;
  END IF;
  IF NEW."status" = 'completed' AND OLD."status" = 'ordered' AND EXISTS (SELECT 1 FROM "DischargeStep" WHERE "dischargeId" = OLD."id" AND "status" <> 'done') THEN
    RAISE EXCEPTION 'Discharge %: completed when all six steps are done', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER discharge_guard BEFORE INSERT OR UPDATE OR DELETE ON "Discharge" FOR EACH ROW EXECUTE FUNCTION discharge_guard();

-- A step: waiting → in-progress (when the steps it waits for are done) → done (who, when); on an ordered discharge only.
CREATE OR REPLACE FUNCTION discharge_step_waits(k text) RETURNS text[] AS $$
  SELECT CASE k WHEN 'order' THEN ARRAY[]::text[] WHEN 'summary' THEN ARRAY['order'] WHEN 'pharmacy' THEN ARRAY['order']
    WHEN 'final-bill' THEN ARRAY['pharmacy'] WHEN 'payment' THEN ARRAY['final-bill'] WHEN 'bed-release' THEN ARRAY['summary', 'payment'] END;
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION discharge_step_guard() RETURNS trigger AS $$
DECLARE d RECORD; open_deps int;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DischargeStep %: never deleted', OLD."id"; END IF;
  SELECT * INTO d FROM "Discharge" WHERE "id" = NEW."dischargeId";
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."dischargeId", NEW."key", NEW."tenantId") IS DISTINCT FROM (OLD."dischargeId", OLD."key", OLD."tenantId") THEN RAISE EXCEPTION 'DischargeStep %: its discharge and key never change', OLD."id"; END IF;
    IF d."status" <> 'ordered' THEN RAISE EXCEPTION 'DischargeStep %: the discharge is %', OLD."id", d."status"; END IF;
    IF OLD."status" = 'done' AND (to_jsonb(NEW) - ARRAY['remindedById', 'remindedAt', 'reminders']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['remindedById', 'remindedAt', 'reminders']) THEN RAISE EXCEPTION 'DischargeStep %: done is final', OLD."id"; END IF;
    IF NOT ((OLD."status" = NEW."status") OR (OLD."status" = 'waiting' AND NEW."status" = 'in-progress') OR (OLD."status" = 'in-progress' AND NEW."status" = 'done')) THEN
      RAISE EXCEPTION 'DischargeStep %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
    END IF;
    IF NEW."status" = 'done' AND OLD."status" <> 'done' AND NOT lab_actor_ok(NEW."doneById") THEN RAISE EXCEPTION 'DischargeStep %: done by the signed-in user', OLD."id"; END IF;
    IF NEW."takenById" IS DISTINCT FROM OLD."takenById" AND NEW."takenById" IS NOT NULL AND NOT lab_actor_ok(NEW."takenById") THEN RAISE EXCEPTION 'DischargeStep %: taken by the signed-in user', OLD."id"; END IF;
    IF NEW."remindedAt" IS DISTINCT FROM OLD."remindedAt" AND (NOT lab_actor_ok(NEW."remindedById") OR NEW."reminders" <> OLD."reminders" + 1) THEN RAISE EXCEPTION 'DischargeStep %: a reminder is counted and signed', OLD."id"; END IF;
  ELSIF d."status" <> 'ordered' THEN RAISE EXCEPTION 'DischargeStep: the discharge is %', d."status";
  END IF;
  IF NEW."status" <> 'waiting' AND (TG_OP = 'INSERT' OR OLD."status" = 'waiting') THEN
    SELECT count(*) INTO open_deps FROM unnest(discharge_step_waits(NEW."key")) w(k)
      WHERE NOT EXISTS (SELECT 1 FROM "DischargeStep" s WHERE s."dischargeId" = NEW."dischargeId" AND s."key" = w.k AND s."status" = 'done');
    IF open_deps > 0 THEN RAISE EXCEPTION 'DischargeStep: % waits for its earlier steps', NEW."key"; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER discharge_step_guard BEFORE INSERT OR UPDATE OR DELETE ON "DischargeStep" FOR EACH ROW EXECUTE FUNCTION discharge_step_guard();
-- A discharge has its six steps (at commit).
CREATE OR REPLACE FUNCTION discharge_has_steps() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM "DischargeStep" WHERE "dischargeId" = NEW."id") <> 6 THEN RAISE EXCEPTION 'Discharge %: has its six steps', NEW."id"; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER discharge_has_steps AFTER INSERT ON "Discharge" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION discharge_has_steps();

-- ───── rates and packages ─────
ALTER TABLE "BedClassRate" ADD CONSTRAINT bed_class_rate_amount CHECK ("perDayPaisa" >= 0 AND "perDayPaisa" <= 100000000);
ALTER TABLE "Package" ADD CONSTRAINT package_shape CHECK ("days" >= 1 AND "days" <= 60 AND "validFrom" ~ '^\d{4}-\d{2}-\d{2}$' AND ("validTo" IS NULL OR "validTo" >= "validFrom"));
ALTER TABLE "PackagePrice" ADD CONSTRAINT package_price_amount CHECK ("pricePaisa" > 0 AND "pricePaisa" <= 100000000);
ALTER TABLE "PackageItem" ADD CONSTRAINT package_item_shape CHECK ("kind" IN ('service', 'medicine', 'excluded') AND (("kind" = 'excluded') = ("code" IS NULL)) AND ("limitQty" IS NULL OR ("kind" = 'service' AND "limitQty" >= 1)));

-- ───── row-level security ─────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BedClassRate', 'Package', 'PackagePrice', 'PackageItem', 'Discharge', 'DischargeStep'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))', t);
    EXECUTE format('REVOKE DELETE ON %I FROM setu_app', t);
  END LOOP;
END $$;

-- ───── the bed-day census (the minute sweep) ─────
-- Admitted admissions whose bill lacks a bed day that is due: day n is due from 00:01 Dhaka of admit day + n − 1.
CREATE OR REPLACE FUNCTION bed_day_sweep_targets(p_now timestamptz)
RETURNS TABLE (tenant_id text, admission_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a."tenantId", a."id" FROM "Admission" a
  WHERE a."status" = 'admitted' AND a."invoiceId" IS NOT NULL
    AND ((p_now - interval '1 minute') AT TIME ZONE 'Asia/Dhaka')::date - ((a."admittedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date + 1
        > coalesce((SELECT max(c."dayNo") FROM "ChargeItem" c WHERE c."invoiceId" = a."invoiceId" AND c."source" = 'bed-day'), 0)
  ORDER BY a."admittedAt" LIMIT 200;
$$;
REVOKE ALL ON FUNCTION bed_day_sweep_targets(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bed_day_sweep_targets(timestamptz) TO setu_app;

-- ───── the rates every facility with beds starts from (the old sample classes, `sample` until the owner sets them) ─────
INSERT INTO "BedClassRate" ("id", "tenantId", "organizationId", "bedClass", "nameEn", "nameBn", "perDayPaisa", "sample")
SELECT 'bcr_' || md5(l."tenantId" || l."organizationId" || v.c), l."tenantId", l."organizationId", v.c, v.en, v.bn, v.p, true
FROM (SELECT DISTINCT "tenantId", "organizationId" FROM "Location" WHERE "kind" = 'bed') l
CROSS JOIN (VALUES ('General', 'General ward', 'সাধারণ ওয়ার্ড', 120000), ('Cabin', 'Cabin (AC)', 'কেবিন (এসি)', 450000),
                   ('HDU', 'HDU', 'এইচডিইউ', 800000), ('ICU', 'ICU', 'আইসিইউ', 1500000), ('ER', 'ER bay', 'জরুরি বিভাগের বে', 0)) v(c, en, bn, p)
ON CONFLICT DO NOTHING;
