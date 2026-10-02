-- ADR 0005 guards, in their own migration: the enum value added by 20261002215727_billing_followups must be committed
-- before an index predicate or a CHECK can use it.

-- Void shape: entered-in-error ⇔ who / when / why (reason ≥10); a voided bill holds no money.
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_void_shape CHECK (
  ("status" = 'entered-in-error') = ("voidedAt" IS NOT NULL)
  AND ("voidedAt" IS NULL OR ("voidedById" IS NOT NULL AND length(btrim(coalesce("voidReason", ''))) >= 10 AND "paidPaisa" = 0)));
-- A voided draft has no number; every other non-draft bill has one.
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_issued_shape;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_issued_shape CHECK (
  "status" = 'draft'
  OR ("status" = 'entered-in-error' AND "issuedAt" IS NULL AND "number" IS NULL)
  OR ("number" IS NOT NULL AND "issuedAt" IS NOT NULL AND "issuedById" IS NOT NULL));
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_replacement_shape CHECK (
  ("replacedById" IS NULL OR "status" = 'entered-in-error') AND ("replacesId" IS NULL OR "replacesId" <> "id"));
-- One open bill per visit: neither a cancelled nor a voided bill counts, so a voided bill can be replaced.
DROP INDEX "Invoice_one_per_encounter";
CREATE UNIQUE INDEX "Invoice_one_per_encounter" ON "Invoice" ("tenantId", "encounterId") WHERE "status" NOT IN ('cancelled', 'entered-in-error');

-- "Not billed here" (decision 98): only an unpriced order line, with the approving Task and a reason.
ALTER TABLE "ChargeItem" ADD CONSTRAINT charge_item_not_billed CHECK (
  "notBilledTaskId" IS NULL
  OR ("unitPaisa" IS NULL AND "source" = 'order' AND "notBilledAt" IS NOT NULL AND length(btrim(coalesce("notBilledReason", ''))) >= 10));

CREATE OR REPLACE FUNCTION invoice_guard() RETURNS trigger AS $$
DECLARE
  sums record;
  n_lines int;
  n_unpriced int;
  paid int;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invoice is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' THEN RAISE EXCEPTION 'Invoice: a new bill starts as a draft'; END IF;
    RETURN NEW;
  END IF;

  -- Confirmed money on the bill is always the sum of its confirmed payments.
  SELECT coalesce(sum("amountPaisa"), 0) INTO paid FROM "Payment" WHERE "invoiceId" = NEW."id" AND "status" = 'confirmed';
  IF NEW."paidPaisa" <> paid THEN RAISE EXCEPTION 'Invoice %: paid % is not the sum of confirmed payments %', NEW."id", NEW."paidPaisa", paid; END IF;

  -- A voided bill is frozen; only its replacement may be recorded, once (ADR 0005).
  IF OLD."status" = 'entered-in-error' THEN
    IF OLD."replacedById" IS NULL AND NEW."replacedById" IS NOT NULL
       AND (to_jsonb(NEW) - 'replacedById') = (to_jsonb(OLD) - 'replacedById') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Invoice %: a voided bill is never changed', OLD."id";
  END IF;

  -- Void (INVOICE markError): only from draft or issued, no confirmed money, no pending payment.
  IF NEW."status" = 'entered-in-error' THEN
    IF OLD."status" NOT IN ('draft', 'issued') THEN RAISE EXCEPTION 'Invoice %: a % bill cannot be voided', OLD."id", OLD."status"; END IF;
    IF paid <> 0 THEN RAISE EXCEPTION 'Invoice %: confirmed money is on the bill — it cannot be voided', OLD."id"; END IF;
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
    -- Issue: no approval still requested on the bill (discount or "Not billed here"), every line priced or approved
    -- as not billed here, at least one line, and the totals are exactly the sums of the line paisa.
    IF EXISTS (SELECT 1 FROM "Task" WHERE "focusId" = NEW."id" AND "kind" IN ('discount-approval', 'bill-elsewhere') AND "status" = 'requested') THEN
      RAISE EXCEPTION 'Invoice %: an approval is still requested on this bill', OLD."id";
    END IF;
    SELECT count(*), count(*) FILTER (WHERE "unitPaisa" IS NULL AND "notBilledTaskId" IS NULL) INTO n_lines, n_unpriced FROM "ChargeItem" WHERE "invoiceId" = NEW."id";
    IF n_lines = 0 THEN RAISE EXCEPTION 'Invoice %: no lines', OLD."id"; END IF;
    IF n_unpriced > 0 THEN RAISE EXCEPTION 'Invoice %: % line(s) have no price', OLD."id", n_unpriced; END IF;
    SELECT sum("grossPaisa") AS g, sum("discountPaisa") AS d, sum("netPaisa") AS n, sum("vatPaisa") AS v, sum("totalPaisa") AS t
      INTO sums FROM "ChargeItem" WHERE "invoiceId" = NEW."id";
    IF (sums.g, sums.d, sums.n, sums.v, sums.t) IS DISTINCT FROM
       (NEW."subtotalPaisa"::bigint, NEW."discountPaisa"::bigint, NEW."netPaisa"::bigint, NEW."vatPaisa"::bigint, NEW."totalPaisa"::bigint) THEN
      RAISE EXCEPTION 'Invoice %: totals are not the sums of the line paisa', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  -- Issued or later: lines, totals, discount and number are frozen; only status, paidPaisa and statusAt move.
  IF (to_jsonb(NEW) - ARRAY['status', 'paidPaisa', 'statusAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'paidPaisa', 'statusAt']) THEN
    RAISE EXCEPTION 'Invoice %: an issued bill is never edited', OLD."id";
  END IF;
  IF NEW."paidPaisa" < OLD."paidPaisa" THEN RAISE EXCEPTION 'Invoice %: paid money never goes down', OLD."id"; END IF;
  IF NOT (
       (OLD."status" = 'issued' AND NEW."status" IN ('issued', 'partially-paid', 'balanced'))
    OR (OLD."status" = 'partially-paid' AND NEW."status" IN ('partially-paid', 'balanced'))
  ) THEN
    RAISE EXCEPTION 'Invoice %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
