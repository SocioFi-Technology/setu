-- Refunds (ADR 0013), Kamrul's decisions of 05/10/2026 on open questions 220–232:
-- 220 one refund = one payout method, paid whole (a gateway refund against one payment, never part-paid);
-- 221 a return without refund on an unpaid pharmacy bill: the medicine comes back, the due goes down (Invoice.creditedPaisa),
--     a credit voucher (CV/yy/nnnn), no money; once the due is zero and no money was ever confirmed the bill can be voided;
-- 223 the requester decides their own refund only as the facility's only approver, with a note, flagged self-approved.
ALTER TABLE "Invoice" ADD COLUMN "creditedPaisa" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Receipt" ADD COLUMN "creditedPaisa" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Refund" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'refund', ADD COLUMN "selfApproved" BOOLEAN NOT NULL DEFAULT false;

-- the due is what is left after confirmed money and credited returns
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_amounts;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_amounts CHECK ("subtotalPaisa" >= 0 AND "discountPaisa" >= 0 AND "vatPaisa" >= 0 AND "paidPaisa" >= 0 AND "creditedPaisa" >= 0
  AND "discountPaisa" <= "subtotalPaisa" AND "netPaisa" = "subtotalPaisa" - "discountPaisa" AND "totalPaisa" = "netPaisa" + "vatPaisa" AND "paidPaisa" + "creditedPaisa" <= "totalPaisa");
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_paid_matches_status;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_paid_matches_status CHECK (
  ("status" <> 'draft' OR ("paidPaisa" = 0 AND "creditedPaisa" = 0)) AND ("status" <> 'issued' OR "paidPaisa" = 0)
  AND ("status" <> 'partially-paid' OR ("paidPaisa" > 0 AND "paidPaisa" < "totalPaisa" - "creditedPaisa"))
  AND ("status" <> 'balanced' OR "paidPaisa" = "totalPaisa" - "creditedPaisa"));
ALTER TABLE "Receipt" DROP CONSTRAINT receipt_amounts;
ALTER TABLE "Receipt" ADD CONSTRAINT receipt_amounts CHECK ("paidPaisa" > 0 AND "totalPaisa" >= 0 AND "duePaisa" >= 0 AND "creditedPaisa" >= 0 AND "paidPaisa" + "duePaisa" + "creditedPaisa" = "totalPaisa");

ALTER TABLE "Refund" DROP CONSTRAINT refund_shape;
ALTER TABLE "Refund" ADD CONSTRAINT refund_shape CHECK (
  "source" IN ('bill', 'reconciliation') AND "kind" IN ('refund', 'return')
  AND "category" IN ('cancelled-test', 'wrong-dispense', 'overpayment', 'patient-request', 'other')
  AND ("kind" = 'refund' OR ("source" = 'bill' AND "category" IN ('wrong-dispense', 'patient-request', 'other')))
  AND length(btrim("reason")) >= 10
  AND "amountPaisa" > 0 AND "amountPaisa" <= 1000000000 AND "netPaisa" >= 0 AND "vatPaisa" >= 0 AND "netPaisa" + "vatPaisa" = "amountPaisa"
  AND (("source" = 'reconciliation') = ("caseTaskId" IS NOT NULL))
  AND (("source" = 'reconciliation') = ("category" = 'overpayment'))
  AND ("source" = 'bill' OR "vatPaisa" = 0)
  AND ("recipientRelation" IS NULL OR "recipientRelation" IN ('self', 'spouse', 'parent', 'child', 'sibling', 'other-relative', 'other'))
  AND ("recipientPhone" IS NULL OR "recipientPhone" ~ '^1[3-9][0-9]{8}$')
  AND ("recipientName" IS NULL OR length(btrim("recipientName")) BETWEEN 2 AND 80)
  AND (("status" = 'paid') = ("paidAt" IS NOT NULL))
  -- who took the money: required when money leaves (a return without refund moves none)
  AND ("status" <> 'paid' OR "kind" = 'return' OR ("recipientName" IS NOT NULL AND "recipientPhone" IS NOT NULL AND "recipientRelation" IS NOT NULL))
  AND ("status" <> 'rejected' OR length(btrim(coalesce("decisionNote", ''))) >= 10)
  AND (("status" = 'withdrawn') = ("withdrawnAt" IS NOT NULL))
  AND ("status" <> 'withdrawn' OR length(btrim(coalesce("withdrawNote", ''))) >= 10)
  AND (NOT "selfApproved" OR length(btrim(coalesce("decisionNote", ''))) >= 10)
);
ALTER TABLE "RefundVoucher" DROP CONSTRAINT refund_voucher_shape;
ALTER TABLE "RefundVoucher" ADD CONSTRAINT refund_voucher_shape CHECK ("verifyCode" ~ '^[0-9A-HJKMNP-TV-Z]{20,}$' AND "number" ~ '^(RF|CV)/[0-9]{2}/[0-9]{4,}$' AND "amountPaisa" > 0);

-- the owner / admin of a facility who can decide (active users)
CREATE OR REPLACE FUNCTION facility_approvers(p_org text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT r."userId")::int FROM "PractitionerRole" r JOIN "User" u ON u."id" = r."userId"
  WHERE r."organizationId" = p_org AND r."role" IN ('owner', 'admin') AND u."active";
$$;

CREATE OR REPLACE FUNCTION refund_guard() RETURNS trigger AS $$
DECLARE inv RECORD; t RECORD; n_open int; self boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Refund is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'requested' OR NEW."decidedById" IS NOT NULL OR NEW."paidAt" IS NOT NULL OR NEW."recipientName" IS NOT NULL OR NEW."withdrawnById" IS NOT NULL THEN
      RAISE EXCEPTION 'Refund: a new refund starts as requested (REFUND machine)';
    END IF;
    IF NOT lab_actor_ok(NEW."requestedById") THEN RAISE EXCEPTION 'Refund: requested by someone other than the signed-in user'; END IF;
    SELECT * INTO inv FROM "Invoice" WHERE "id" = NEW."invoiceId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND OR inv."organizationId" <> NEW."organizationId" OR inv."patientId" IS DISTINCT FROM NEW."patientId" THEN
      RAISE EXCEPTION 'Refund: the bill is not at this facility or not this patient''s';
    END IF;
    IF inv."status" NOT IN ('issued', 'partially-paid', 'balanced') THEN RAISE EXCEPTION 'Refund: the bill is % — only an issued bill is refunded', inv."status"; END IF;
    -- decision 221: a return without refund only on an issued pharmacy / OTC bill that never held money and has nothing pending
    IF NEW."kind" = 'return' AND (inv."status" <> 'issued' OR inv."paidPaisa" <> 0 OR inv."kind" NOT IN ('pharmacy', 'otc')
       OR EXISTS (SELECT 1 FROM "Payment" WHERE "invoiceId" = inv."id" AND "status" IN ('initiated', 'link-sent', 'waiting-customer', 'confirmed'))) THEN
      RAISE EXCEPTION 'Refund: a return without refund is only for an unpaid pharmacy bill';
    END IF;
    IF NEW."selfApproved" THEN RAISE EXCEPTION 'Refund: self-approval is recorded at the decision'; END IF;
    SELECT * INTO t FROM "Task" WHERE "id" = NEW."approvalTaskId";
    IF NOT FOUND OR t."kind" <> 'refund-approval' OR t."status" <> 'requested' OR t."focusId" <> NEW."invoiceId" OR t."requestedById" <> NEW."requestedById" THEN
      RAISE EXCEPTION 'Refund: a refund is requested through its approval task';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."tenantId", NEW."organizationId", NEW."invoiceId", NEW."patientId", NEW."source", NEW."caseTaskId", NEW."category", NEW."reason",
      NEW."amountPaisa", NEW."netPaisa", NEW."vatPaisa", NEW."needsOwner", NEW."approvalTaskId", NEW."requestedById", NEW."requestedAt", NEW."kind")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."organizationId", OLD."invoiceId", OLD."patientId", OLD."source", OLD."caseTaskId", OLD."category", OLD."reason",
      OLD."amountPaisa", OLD."netPaisa", OLD."vatPaisa", OLD."needsOwner", OLD."approvalTaskId", OLD."requestedById", OLD."requestedAt", OLD."kind") THEN
    RAISE EXCEPTION 'Refund %: what was requested never changes', OLD."id";
  END IF;
  IF OLD."status" IN ('paid', 'rejected', 'withdrawn') THEN RAISE EXCEPTION 'Refund %: a % refund is never changed', OLD."id", OLD."status"; END IF;

  IF NEW."status" = OLD."status" THEN
    -- the payout records who took the money once (a gateway refund is answered after the commit, ADR 0013)
    IF OLD."status" = 'approved' AND OLD."recipientName" IS NULL AND NEW."recipientName" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['rev', 'statusAt', 'recipientName', 'recipientPhone', 'recipientRelation']) = (to_jsonb(OLD) - ARRAY['rev', 'statusAt', 'recipientName', 'recipientPhone', 'recipientRelation']) THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['rev', 'statusAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['rev', 'statusAt']) THEN
      RAISE EXCEPTION 'Refund %: only a step of the REFUND machine changes it', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'requested' AND NEW."status" IN ('approved', 'rejected') THEN
    IF NEW."decidedById" IS NULL OR NOT lab_actor_ok(NEW."decidedById") OR NEW."decidedAt" IS NULL THEN RAISE EXCEPTION 'Refund %: decided by someone other than the signed-in user', OLD."id"; END IF;
    -- decision 223: the person who asked decides only as the facility's only approver, with a note, flagged
    self := NEW."decidedById" = OLD."requestedById";
    IF self <> NEW."selfApproved" THEN RAISE EXCEPTION 'Refund %: self-approved exactly when the requester decides', OLD."id"; END IF;
    IF self AND (facility_approvers(OLD."organizationId") <> 1 OR length(btrim(coalesce(NEW."decisionNote", ''))) < 10) THEN
      RAISE EXCEPTION 'Refund %: never decided by the person who asked while another approver exists (alone: with a note)', OLD."id";
    END IF;
    IF NOT is_stock_approver(NEW."decidedById", OLD."organizationId") THEN RAISE EXCEPTION 'Refund %: only the owner or an admin decides', OLD."id"; END IF;
    IF NEW."status" = 'approved' AND OLD."needsOwner" AND NOT EXISTS (
      SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = NEW."decidedById" AND r."organizationId" = OLD."organizationId" AND r."role" = 'owner') THEN
      RAISE EXCEPTION 'Refund %: this refund is approved by the owner', OLD."id";
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Task" WHERE "id" = OLD."approvalTaskId" AND "status" = NEW."status"::text::"ApprovalStatus" AND "decidedById" = NEW."decidedById") THEN
      RAISE EXCEPTION 'Refund %: decided through its approval task', OLD."id";
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'statusAt', 'rev', 'decidedById', 'decidedAt', 'decisionNote', 'selfApproved']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'statusAt', 'rev', 'decidedById', 'decidedAt', 'decisionNote', 'selfApproved']) THEN
      RAISE EXCEPTION 'Refund %: deciding changes nothing else', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'approved' AND NEW."status" = 'withdrawn' THEN
    IF NEW."withdrawnById" IS NULL OR NOT lab_actor_ok(NEW."withdrawnById") OR NOT is_stock_approver(NEW."withdrawnById", OLD."organizationId") THEN
      RAISE EXCEPTION 'Refund %: only the owner or an admin withdraws a refund', OLD."id";
    END IF;
    IF EXISTS (SELECT 1 FROM "RefundAllocation" WHERE "refundId" = OLD."id" AND ("status" <> 'open' OR "gatewayFailedAt" IS NOT NULL))
       OR EXISTS (SELECT 1 FROM "StockMove" m JOIN "RefundLine" l ON l."id" = m."refId" WHERE m."refType" = 'refund-line' AND l."refundId" = OLD."id") THEN
      RAISE EXCEPTION 'Refund %: the payout has started — it cannot be withdrawn', OLD."id";
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'statusAt', 'rev', 'withdrawnById', 'withdrawnAt', 'withdrawNote']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'statusAt', 'rev', 'withdrawnById', 'withdrawnAt', 'withdrawNote']) THEN
      RAISE EXCEPTION 'Refund %: withdrawing changes nothing else', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'approved' AND NEW."status" = 'paid' THEN
    IF EXISTS (SELECT 1 FROM "RefundAllocation" WHERE "refundId" = OLD."id" AND "status" <> 'paid') THEN
      RAISE EXCEPTION 'Refund %: paid only when every part of it was paid out', OLD."id";
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'statusAt', 'rev', 'paidAt', 'recipientName', 'recipientPhone', 'recipientRelation']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'statusAt', 'rev', 'paidAt', 'recipientName', 'recipientPhone', 'recipientRelation']) THEN
      RAISE EXCEPTION 'Refund %: paying changes nothing else', OLD."id";
    END IF;
    IF OLD."recipientName" IS NOT NULL AND (NEW."recipientName", NEW."recipientPhone", NEW."recipientRelation") IS DISTINCT FROM (OLD."recipientName", OLD."recipientPhone", OLD."recipientRelation") THEN
      RAISE EXCEPTION 'Refund %: who took the money is recorded once', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Refund %: cannot move from % to % (REFUND machine)', OLD."id", OLD."status", NEW."status";
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refund_consistent() RETURNS trigger AS $$
DECLARE rid text; r RECORD; inv RECORD; s RECORD; a RECORD; live bigint; refunded bigint; credited bigint;
BEGIN
  -- NEW has no "refundId" on the Refund table itself (a CASE would still resolve both columns)
  IF TG_TABLE_NAME = 'Refund' THEN rid := NEW."id"; ELSE rid := NEW."refundId"; END IF;
  SELECT * INTO r FROM "Refund" WHERE "id" = rid;
  SELECT * INTO inv FROM "Invoice" WHERE "id" = r."invoiceId";
  SELECT count(*) AS n, coalesce(sum("netPaisa"), 0) AS net, coalesce(sum("vatPaisa"), 0) AS vat, coalesce(sum("totalPaisa"), 0) AS tot INTO s FROM "RefundLine" WHERE "refundId" = rid;
  IF r."source" = 'bill' AND (s.n = 0 OR (s.net, s.vat, s.tot) IS DISTINCT FROM (r."netPaisa"::bigint, r."vatPaisa"::bigint, r."amountPaisa"::bigint)) THEN
    RAISE EXCEPTION 'Refund %: the refund is not the sum of its lines', rid;
  END IF;
  IF r."source" = 'reconciliation' AND s.n > 0 THEN RAISE EXCEPTION 'Refund %: a reconciliation refund has no bill lines', rid; END IF;
  SELECT count(*) AS n, coalesce(sum("amountPaisa"), 0) AS tot, count(*) FILTER (WHERE "status" <> 'paid') AS unpaid, count(*) FILTER (WHERE "status" = 'paid') AS paid,
         count(DISTINCT "way" || ':' || coalesce("cashReason", '')) AS ways, count(*) FILTER (WHERE "way" = 'gateway') AS gw
    INTO a FROM "RefundAllocation" WHERE "refundId" = rid;
  IF r."kind" = 'return' THEN
    -- decision 221: a return without refund moves no money
    IF a.n > 0 THEN RAISE EXCEPTION 'Refund %: a return without refund has no payout', rid; END IF;
  ELSE
    IF a.n = 0 OR a.tot <> r."amountPaisa" THEN RAISE EXCEPTION 'Refund %: the allocations do not add up to the refund', rid; END IF;
    -- decision 220: one payout method per refund, paid whole — a gateway refund against one payment, never part-paid
    IF a.ways > 1 OR a.gw > 1 THEN RAISE EXCEPTION 'Refund %: one refund goes back one way (a gateway refund: one payment)', rid; END IF;
    IF a.paid > 0 AND a.unpaid > 0 THEN RAISE EXCEPTION 'Refund %: a refund is never part-paid', rid; END IF;
  END IF;
  IF r."source" = 'reconciliation' AND a.n <> 1 THEN RAISE EXCEPTION 'Refund %: a reconciliation refund goes back in one piece', rid; END IF;
  -- never more than the confirmed money on the bill
  SELECT coalesce(sum("amountPaisa"), 0) INTO live FROM "Refund" WHERE "invoiceId" = r."invoiceId" AND "source" = 'bill' AND "kind" = 'refund' AND "status" NOT IN ('rejected', 'withdrawn');
  IF live > inv."paidPaisa" THEN RAISE EXCEPTION 'Refund %: more than the confirmed money on the bill', rid; END IF;
  -- the bill's refunded money is the sum of what was paid out of its bill refunds
  SELECT coalesce(sum(x."amountPaisa"), 0) INTO refunded FROM "RefundAllocation" x JOIN "Refund" y ON y."id" = x."refundId"
    WHERE y."invoiceId" = r."invoiceId" AND y."source" = 'bill' AND x."status" = 'paid';
  IF refunded <> inv."refundedPaisa" THEN RAISE EXCEPTION 'Invoice %: refunded % is not what its refunds paid out %', inv."id", inv."refundedPaisa", refunded; END IF;
  SELECT coalesce(sum("amountPaisa"), 0) INTO credited FROM "Refund" WHERE "invoiceId" = r."invoiceId" AND "kind" = 'return' AND "status" = 'paid';
  IF credited <> inv."creditedPaisa" THEN RAISE EXCEPTION 'Invoice %: credited % is not its recorded returns %', inv."id", inv."creditedPaisa", credited; END IF;
  IF r."kind" = 'refund' AND (r."status" = 'paid') <> (a.unpaid = 0) THEN RAISE EXCEPTION 'Refund %: paid exactly when every allocation is paid', rid; END IF;
  IF r."status" = 'paid' AND NOT EXISTS (SELECT 1 FROM "RefundVoucher" WHERE "refundId" = rid AND "amountPaisa" = r."amountPaisa") THEN
    RAISE EXCEPTION 'Refund %: a paid refund has its voucher', rid;
  END IF;
  -- medicine on a refund comes back (into quarantine) once its payout started, and only then
  IF r."status" = 'paid' OR EXISTS (SELECT 1 FROM "RefundAllocation" WHERE "refundId" = rid AND "status" <> 'open') THEN
    IF EXISTS (SELECT 1 FROM "RefundLine" l WHERE l."refundId" = rid AND l."units" IS NOT NULL
               AND coalesce((SELECT sum(m."qty") FROM "StockMove" m WHERE m."refType" = 'refund-line' AND m."refId" = l."id"), 0) <> l."units") THEN
      RAISE EXCEPTION 'Refund %: returned medicine is recorded with the payout', rid;
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

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

  -- Confirmed money on the bill is always the sum of its confirmed payments.
  SELECT coalesce(sum("amountPaisa"), 0) INTO paid FROM "Payment" WHERE "invoiceId" = NEW."id" AND "status" = 'confirmed';
  IF NEW."paidPaisa" <> paid THEN RAISE EXCEPTION 'Invoice %: paid % is not the sum of confirmed payments %', NEW."id", NEW."paidPaisa", paid; END IF;
  -- ADR 0013: refunded money is what its bill refunds paid out, never more than was paid, never going down.
  SELECT coalesce(sum(x."amountPaisa"), 0) INTO refunded FROM "RefundAllocation" x JOIN "Refund" y ON y."id" = x."refundId"
    WHERE y."invoiceId" = NEW."id" AND y."source" = 'bill' AND x."status" = 'paid';
  IF NEW."refundedPaisa" <> refunded THEN RAISE EXCEPTION 'Invoice %: refunded % is not what its refunds paid out %', NEW."id", NEW."refundedPaisa", refunded; END IF;
  IF NEW."refundedPaisa" > NEW."paidPaisa" OR NEW."refundedPaisa" < OLD."refundedPaisa" THEN RAISE EXCEPTION 'Invoice %: refunded money is within what was paid and never goes down', NEW."id"; END IF;
  -- decision 221: credited = its recorded returns without refund; never goes down
  SELECT coalesce(sum("amountPaisa"), 0) INTO credited FROM "Refund" WHERE "invoiceId" = NEW."id" AND "kind" = 'return' AND "status" = 'paid';
  IF NEW."creditedPaisa" <> credited OR NEW."creditedPaisa" < OLD."creditedPaisa" THEN RAISE EXCEPTION 'Invoice %: credited % is not its recorded returns %', NEW."id", NEW."creditedPaisa", credited; END IF;

  -- A voided bill is frozen; only its replacement may be recorded, once (ADR 0005).
  IF OLD."status" = 'entered-in-error' THEN
    IF OLD."replacedById" IS NULL AND NEW."replacedById" IS NOT NULL AND invoice_replacement_ok(OLD, NEW."replacedById")
       AND (to_jsonb(NEW) - 'replacedById') = (to_jsonb(OLD) - 'replacedById') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Invoice %: a voided bill is never changed', OLD."id";
  END IF;

  -- Void (INVOICE markError): from draft or issued without money, or (ADR 0013) from partially-paid / balanced once every
  -- paisa was refunded, no refund is open and every unit of medicine on it came back; never with a pending payment.
  IF NEW."status" = 'entered-in-error' THEN
    IF OLD."status" NOT IN ('draft', 'issued', 'partially-paid', 'balanced') THEN RAISE EXCEPTION 'Invoice %: a % bill cannot be voided', OLD."id", OLD."status"; END IF;
    IF paid <> NEW."refundedPaisa" THEN RAISE EXCEPTION 'Invoice %: confirmed money is on the bill — it cannot be voided', OLD."id"; END IF;
    IF EXISTS (SELECT 1 FROM "Refund" WHERE "invoiceId" = NEW."id" AND "status" IN ('requested', 'approved')) THEN
      RAISE EXCEPTION 'Invoice %: a refund is open on the bill — decide it first', OLD."id";
    END IF;
    -- medicine off the shelf: a dispense line always (stock moves at dispense), a sale line once the sale was issued
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

  -- Issued or later: lines, totals, discount and number are frozen; only status, paidPaisa, refundedPaisa and statusAt move.
  IF (to_jsonb(NEW) - ARRAY['status', 'paidPaisa', 'refundedPaisa', 'creditedPaisa', 'statusAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'paidPaisa', 'refundedPaisa', 'creditedPaisa', 'statusAt']) THEN
    RAISE EXCEPTION 'Invoice %: an issued bill is never edited', OLD."id";
  END IF;
  IF NEW."paidPaisa" < OLD."paidPaisa" THEN RAISE EXCEPTION 'Invoice %: paid money never goes down', OLD."id"; END IF;
  IF NOT (
       (OLD."status" = 'issued' AND NEW."status" IN ('issued', 'partially-paid', 'balanced'))
    OR (OLD."status" = 'partially-paid' AND NEW."status" IN ('partially-paid', 'balanced'))
    OR (OLD."status" = 'balanced' AND NEW."status" = 'balanced')
  ) THEN
    RAISE EXCEPTION 'Invoice %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
