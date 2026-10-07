-- ADR 0018 guards (slice B10–B12).

-- ───── B10: the IPD final bill ─────
-- The excess: IPD only, 0 on a draft, set once at issue (an issued bill is never edited — invoice_guard).
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_excess CHECK ("excessPaisa" >= 0 AND ("kind" = 'ipd' OR "excessPaisa" = 0) AND ("status" <> 'draft' OR "excessPaisa" = 0));
-- The bill counts net paid = paid − excess (the issued IPD bill holds exactly its total).
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_paid_matches_status;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_paid_matches_status CHECK (
  ("status" <> 'draft' OR "creditedPaisa" = 0) AND ("status" <> 'draft' OR "paidPaisa" = 0 OR "kind" = 'ipd')
  AND ("status" <> 'issued' OR "paidPaisa" - "excessPaisa" = 0)
  AND ("status" <> 'partially-paid' OR ("paidPaisa" - "excessPaisa" > 0 AND "paidPaisa" - "excessPaisa" < "totalPaisa" - "creditedPaisa"))
  AND ("status" <> 'balanced' OR "paidPaisa" - "excessPaisa" = "totalPaisa" - "creditedPaisa"));
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_amounts;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_amounts CHECK (
  "subtotalPaisa" >= 0 AND "discountPaisa" >= 0 AND "vatPaisa" >= 0 AND "paidPaisa" >= 0 AND "creditedPaisa" >= 0 AND "discountPaisa" <= "subtotalPaisa"
  AND "netPaisa" = "subtotalPaisa" - "discountPaisa" AND "totalPaisa" = "netPaisa" + "vatPaisa"
  AND ("paidPaisa" - "excessPaisa" + "creditedPaisa" <= "totalPaisa" OR ("kind" = 'ipd' AND "status" = 'draft')));

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
    -- ADR 0018: the IPD final bill holding deposits is issued straight to partly paid or balanced
    IF NOT (NEW."status" = 'issued' OR (OLD."kind" = 'ipd' AND NEW."status" IN ('partially-paid', 'balanced'))) THEN
      RAISE EXCEPTION 'Invoice %: a draft can only be issued or voided', OLD."id";
    END IF;
    IF NEW."excessPaisa" <> GREATEST(0, paid - NEW."totalPaisa") THEN
      RAISE EXCEPTION 'Invoice %: the excess at issue is the deposits beyond the total', OLD."id";
    END IF;
    IF EXISTS (SELECT 1 FROM "Task" WHERE "focusId" = NEW."id" AND "kind" IN ('discount-approval', 'bill-elsewhere') AND "status" = 'requested') THEN
      RAISE EXCEPTION 'Invoice %: an approval is still requested on this bill', OLD."id";
    END IF;
    -- ADR 0017: the lines that count are the ones not superseded; a credit pair never counts as unpriced (ADR 0018)
    SELECT count(*), count(*) FILTER (WHERE "unitPaisa" IS NULL AND "notBilledTaskId" IS NULL AND "creditOfId" IS NULL AND "creditedById" IS NULL)
      INTO n_lines, n_unpriced FROM "ChargeItem" WHERE "invoiceId" = NEW."id" AND "supersededById" IS NULL;
    IF n_lines = 0 AND OLD."kind" <> 'ipd' THEN RAISE EXCEPTION 'Invoice %: no lines', OLD."id"; END IF;
    IF n_unpriced > 0 THEN RAISE EXCEPTION 'Invoice %: % line(s) have no price', OLD."id", n_unpriced; END IF;
    SELECT coalesce(sum("grossPaisa"), 0) AS g, coalesce(sum("discountPaisa"), 0) AS d, coalesce(sum("netPaisa"), 0) AS n, coalesce(sum("vatPaisa"), 0) AS v, coalesce(sum("totalPaisa"), 0) AS t
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

-- The IPD bill leaves its draft only by the final bill: a discharge ordered (any kind), no payment link waiting; never voided.
CREATE OR REPLACE FUNCTION invoice_ipd_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD."kind" = 'ipd' AND OLD."status" = 'draft' AND NEW."status" <> 'draft' THEN
    IF NEW."status" = 'entered-in-error' THEN RAISE EXCEPTION 'Invoice %: the IPD running bill is never voided', OLD."id"; END IF;
    IF NOT EXISTS (SELECT 1 FROM "Discharge" d JOIN "Admission" a ON a."id" = d."admissionId" WHERE a."invoiceId" = OLD."id" AND d."status" IN ('ordered', 'completed')) THEN
      RAISE EXCEPTION 'Invoice %: the final bill is issued once the discharge is ordered', OLD."id";
    END IF;
    IF EXISTS (SELECT 1 FROM "Payment" WHERE "invoiceId" = OLD."id" AND "status" IN ('initiated', 'link-sent', 'waiting-customer')) THEN
      RAISE EXCEPTION 'Invoice %: a deposit link is waiting — confirm or cancel it first', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- At commit: an issued IPD bill with an excess has its deposit-excess refund for exactly that excess.
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
  ELSIF inv."excessPaisa" > 0 AND NOT EXISTS (SELECT 1 FROM "Refund" WHERE "invoiceId" = inv_id AND "source" = 'deposit-excess' AND "amountPaisa" = inv."excessPaisa" AND "status" NOT IN ('rejected', 'withdrawn')) THEN
    RAISE EXCEPTION 'Invoice %: the excess deposit is assigned to its refund in the issuing transaction', inv_id;
  END IF;
END $$ LANGUAGE plpgsql;

-- ───── the deposit-excess refund (decision 297; Kamrul, 3) ─────
ALTER TABLE "Refund" DROP CONSTRAINT refund_shape;
ALTER TABLE "Refund" ADD CONSTRAINT refund_shape CHECK (
  "source" IN ('bill', 'reconciliation', 'deposit-excess') AND "kind" IN ('refund', 'return')
  AND "category" IN ('cancelled-test', 'wrong-dispense', 'overpayment', 'patient-request', 'other', 'deposit-excess')
  AND ("kind" = 'refund' OR ("source" = 'bill' AND "category" IN ('wrong-dispense', 'patient-request', 'other')))
  AND length(btrim("reason")) >= 10 AND "amountPaisa" > 0 AND "amountPaisa" <= 1000000000 AND "netPaisa" >= 0 AND "vatPaisa" >= 0 AND "netPaisa" + "vatPaisa" = "amountPaisa"
  AND ("source" = 'reconciliation') = ("caseTaskId" IS NOT NULL) AND ("source" = 'reconciliation') = ("category" = 'overpayment')
  AND ("source" = 'deposit-excess') = ("category" = 'deposit-excess') AND ("source" <> 'deposit-excess' OR "needsOwner")
  AND ("source" = 'bill' OR "vatPaisa" = 0)
  AND ("recipientRelation" IS NULL OR "recipientRelation" IN ('self', 'spouse', 'parent', 'child', 'sibling', 'other-relative', 'other'))
  AND ("recipientPhone" IS NULL OR "recipientPhone" ~ '^1[3-9][0-9]{8}$') AND ("recipientName" IS NULL OR (length(btrim("recipientName")) >= 2 AND length(btrim("recipientName")) <= 80))
  AND ("status" = 'paid') = ("paidAt" IS NOT NULL)
  AND ("status" <> 'paid' OR "creditPaisa" = "amountPaisa" OR ("recipientName" IS NOT NULL AND "recipientPhone" IS NOT NULL AND "recipientRelation" IS NOT NULL))
  AND ("status" <> 'rejected' OR length(btrim(coalesce("decisionNote", ''))) >= 10)
  AND ("status" = 'withdrawn') = ("withdrawnAt" IS NOT NULL) AND ("status" <> 'withdrawn' OR length(btrim(coalesce("withdrawNote", ''))) >= 10)
  AND (NOT "selfApproved" OR length(btrim(coalesce("decisionNote", ''))) >= 10)
  -- the excess is never rejected or withdrawn: it must always have somewhere to go
  AND ("source" <> 'deposit-excess' OR "status" IN ('requested', 'approved', 'paid')));
-- a wallet deposit paid back in cash as the excess at discharge
ALTER TABLE "RefundAllocation" DROP CONSTRAINT refund_allocation_shape;
ALTER TABLE "RefundAllocation" ADD CONSTRAINT refund_allocation_shape CHECK (
  "amountPaisa" > 0 AND "way" IN ('cash', 'gateway', 'manual') AND "status" IN ('open', 'paying', 'paid')
  AND ("cashReason" IS NULL OR "cashReason" IN ('no-wallet-access', 'gateway-failed', 'deposit-excess'))
  AND ("method" <> 'cash' OR ("way" = 'cash' AND "cashReason" IS NULL))
  AND ("method" NOT IN ('card', 'bank') OR ("way" IN ('manual', 'cash') AND "cashReason" IS NULL))
  AND ("method" NOT IN ('bkash', 'nagad') OR "way" <> 'cash' OR "cashReason" IS NOT NULL)
  AND ("way" = 'cash' OR "cashReason" IS NULL)
  AND (("status" = 'paid') = ("paidAt" IS NOT NULL AND "paidById" IS NOT NULL))
  AND ("status" <> 'paying' OR ("way" = 'gateway' AND "claimedAt" IS NOT NULL AND "claimedById" IS NOT NULL))
  AND ("status" <> 'paid' OR "way" <> 'cash' OR "shiftId" IS NOT NULL)
  AND ("status" <> 'paid' OR "way" <> 'manual' OR length(btrim(coalesce("reference", ''))) >= 3)
  AND ("status" <> 'paid' OR "way" <> 'gateway' OR "refundTrxId" IS NOT NULL)
  AND ("status" <> 'paid' OR NOT ("way" = 'manual' OR ("way" = 'cash' AND "method" IN ('card', 'bank'))) OR "needsReconciliation"));

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
    -- ADR 0018: the excess of an issued IPD bill, exactly, once
    IF NEW."source" = 'deposit-excess' AND (inv."kind" <> 'ipd' OR inv."excessPaisa" <= 0 OR NEW."amountPaisa" <> inv."excessPaisa" OR NEW."kind" <> 'refund'
       OR EXISTS (SELECT 1 FROM "Refund" WHERE "invoiceId" = inv."id" AND "source" = 'deposit-excess')) THEN
      RAISE EXCEPTION 'Refund: a deposit-excess refund is the issued IPD bill''s excess, exactly, once';
    END IF;
    IF NEW."kind" = 'return' AND (inv."status" NOT IN ('issued', 'partially-paid') OR inv."kind" NOT IN ('pharmacy', 'otc')
       OR NEW."creditPaisa" <= 0 OR NEW."creditPaisa" <> LEAST(NEW."amountPaisa", inv."totalPaisa" - inv."creditedPaisa" - inv."paidPaisa")
       OR EXISTS (SELECT 1 FROM "Payment" WHERE "invoiceId" = inv."id" AND "status" IN ('initiated', 'link-sent', 'waiting-customer'))) THEN
      RAISE EXCEPTION 'Refund: a return is for a pharmacy bill with a due — its credit is the lesser of the value and the due';
    END IF;
    IF NEW."kind" = 'refund' AND NEW."creditPaisa" <> 0 THEN RAISE EXCEPTION 'Refund: only a return carries a credit'; END IF;
    IF NEW."selfApproved" THEN RAISE EXCEPTION 'Refund: self-approval is recorded at the decision'; END IF;
    SELECT * INTO t FROM "Task" WHERE "id" = NEW."approvalTaskId";
    IF NOT FOUND OR t."kind" <> 'refund-approval' OR t."status" <> 'requested' OR t."focusId" <> NEW."invoiceId" OR t."requestedById" <> NEW."requestedById" THEN
      RAISE EXCEPTION 'Refund: a refund is requested through its approval task';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."tenantId", NEW."organizationId", NEW."invoiceId", NEW."patientId", NEW."source", NEW."caseTaskId", NEW."category", NEW."reason",
      NEW."amountPaisa", NEW."netPaisa", NEW."vatPaisa", NEW."needsOwner", NEW."approvalTaskId", NEW."requestedById", NEW."requestedAt", NEW."kind", NEW."creditPaisa")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."organizationId", OLD."invoiceId", OLD."patientId", OLD."source", OLD."caseTaskId", OLD."category", OLD."reason",
      OLD."amountPaisa", OLD."netPaisa", OLD."vatPaisa", OLD."needsOwner", OLD."approvalTaskId", OLD."requestedById", OLD."requestedAt", OLD."kind", OLD."creditPaisa") THEN
    RAISE EXCEPTION 'Refund %: what was requested never changes', OLD."id";
  END IF;
  IF OLD."status" IN ('paid', 'rejected', 'withdrawn') THEN RAISE EXCEPTION 'Refund %: a % refund is never changed', OLD."id", OLD."status"; END IF;
  IF OLD."source" = 'deposit-excess' AND NEW."status" IN ('rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'Refund %: the excess deposit is never rejected or withdrawn — only its way back changes', OLD."id";
  END IF;

  IF NEW."status" = OLD."status" THEN
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
  IF TG_TABLE_NAME = 'Refund' THEN rid := NEW."id"; ELSE rid := NEW."refundId"; END IF;
  SELECT * INTO r FROM "Refund" WHERE "id" = rid;
  SELECT * INTO inv FROM "Invoice" WHERE "id" = r."invoiceId";
  SELECT count(*) AS n, coalesce(sum("netPaisa"), 0) AS net, coalesce(sum("vatPaisa"), 0) AS vat, coalesce(sum("totalPaisa"), 0) AS tot INTO s FROM "RefundLine" WHERE "refundId" = rid;
  IF r."source" = 'bill' AND (s.n = 0 OR (s.net, s.vat, s.tot) IS DISTINCT FROM (r."netPaisa"::bigint, r."vatPaisa"::bigint, r."amountPaisa"::bigint)) THEN
    RAISE EXCEPTION 'Refund %: the refund is not the sum of its lines', rid;
  END IF;
  IF r."source" IN ('reconciliation', 'deposit-excess') AND s.n > 0 THEN RAISE EXCEPTION 'Refund %: a % refund has no bill lines', rid, r."source"; END IF;
  -- ADR 0018: a deposit-excess refund may go back against several deposits — one way (its cash reason may differ per method)
  SELECT count(*) AS n, coalesce(sum("amountPaisa"), 0) AS tot, count(*) FILTER (WHERE "status" <> 'paid') AS unpaid, count(*) FILTER (WHERE "status" = 'paid') AS paid,
         count(DISTINCT CASE WHEN r."source" = 'deposit-excess' THEN "way" ELSE "way" || ':' || coalesce("cashReason", '') END) AS ways, count(*) FILTER (WHERE "way" = 'gateway') AS gw
    INTO a FROM "RefundAllocation" WHERE "refundId" = rid;
  IF NOT r."needsOwner" AND EXISTS (SELECT 1 FROM "RefundAllocation" WHERE "refundId" = rid AND "method" IN ('card', 'bank') AND "way" = 'cash') THEN
    RAISE EXCEPTION 'Refund %: card / bank money paid back in cash needs the owner', rid;
  END IF;
  IF a.tot <> r."amountPaisa" - r."creditPaisa" THEN RAISE EXCEPTION 'Refund %: the allocations do not add up to the part refunded', rid; END IF;
  IF r."kind" = 'refund' AND a.n = 0 THEN RAISE EXCEPTION 'Refund %: a refund has a payout', rid; END IF;
  IF a.ways > 1 OR a.gw > 1 THEN RAISE EXCEPTION 'Refund %: one refund goes back one way (a gateway refund: one payment)', rid; END IF;
  IF a.paid > 0 AND a.unpaid > 0 THEN RAISE EXCEPTION 'Refund %: a refund is never part-paid', rid; END IF;
  IF r."source" = 'reconciliation' AND a.n <> 1 THEN RAISE EXCEPTION 'Refund %: a reconciliation refund goes back in one piece', rid; END IF;
  SELECT coalesce(sum("amountPaisa" - "creditPaisa"), 0) INTO live FROM "Refund" WHERE "invoiceId" = r."invoiceId" AND "source" = 'bill' AND "status" NOT IN ('rejected', 'withdrawn');
  -- the bill's own refunds come out of what it keeps: paid − its excess
  IF live > inv."paidPaisa" - inv."excessPaisa" THEN RAISE EXCEPTION 'Refund %: more than the confirmed money on the bill', rid; END IF;
  SELECT coalesce(sum(x."amountPaisa"), 0) INTO refunded FROM "RefundAllocation" x JOIN "Refund" y ON y."id" = x."refundId"
    WHERE y."invoiceId" = r."invoiceId" AND y."source" = 'bill' AND x."status" = 'paid';
  IF refunded <> inv."refundedPaisa" THEN RAISE EXCEPTION 'Invoice %: refunded % is not what its refunds paid out %', inv."id", inv."refundedPaisa", refunded; END IF;
  SELECT coalesce(sum("creditPaisa"), 0) INTO credited FROM "Refund" WHERE "invoiceId" = r."invoiceId" AND "kind" = 'return' AND "status" = 'paid';
  IF credited <> inv."creditedPaisa" THEN RAISE EXCEPTION 'Invoice %: credited % is not its recorded returns %', inv."id", inv."creditedPaisa", credited; END IF;
  IF a.n > 0 AND (r."status" = 'paid') <> (a.unpaid = 0) THEN RAISE EXCEPTION 'Refund %: paid exactly when every allocation is paid', rid; END IF;
  IF r."status" = 'paid' AND NOT EXISTS (SELECT 1 FROM "RefundVoucher" WHERE "refundId" = rid AND "amountPaisa" = r."amountPaisa") THEN
    RAISE EXCEPTION 'Refund %: a paid refund has its voucher', rid;
  END IF;
  IF r."status" = 'paid' OR EXISTS (SELECT 1 FROM "RefundAllocation" WHERE "refundId" = rid AND "status" <> 'open') THEN
    IF EXISTS (SELECT 1 FROM "RefundLine" l WHERE l."refundId" = rid AND l."units" IS NOT NULL
               AND coalesce((SELECT sum(m."qty") FROM "StockMove" m WHERE m."refType" = 'refund-line' AND m."refId" = l."id"), 0) <> l."units") THEN
      RAISE EXCEPTION 'Refund %: returned medicine is recorded with the payout', rid;
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refund_allocation_guard() RETURNS trigger AS $$
DECLARE r RECORD; p RECORD; taken bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'RefundAllocation is never deleted'; END IF;
  SELECT * INTO r FROM "Refund" WHERE "id" = NEW."refundId" AND "tenantId" = NEW."tenantId";
  IF TG_OP = 'INSERT' THEN
    IF NOT FOUND OR r."status" <> 'requested' OR r."decidedById" IS NOT NULL THEN RAISE EXCEPTION 'RefundAllocation: written with the request'; END IF;
    IF NEW."status" <> 'open' OR NEW."claimedAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL OR NEW."refundTrxId" IS NOT NULL OR NEW."gatewayFailedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'RefundAllocation: a new allocation starts open';
    END IF;
    SELECT * INTO p FROM "Payment" WHERE "id" = NEW."paymentId" AND "invoiceId" = r."invoiceId";
    IF NOT FOUND OR p."method" <> NEW."method" THEN RAISE EXCEPTION 'RefundAllocation: not a payment of this bill'; END IF;
    IF r."source" IN ('bill', 'deposit-excess') THEN
      IF p."status" <> 'confirmed' THEN RAISE EXCEPTION 'RefundAllocation: only confirmed money goes back'; END IF;
      SELECT coalesce(sum(a."amountPaisa"), 0) INTO taken FROM "RefundAllocation" a JOIN "Refund" x ON x."id" = a."refundId"
        WHERE a."paymentId" = NEW."paymentId" AND x."source" IN ('bill', 'deposit-excess') AND x."status" NOT IN ('rejected', 'withdrawn');
      IF taken + NEW."amountPaisa" > p."amountPaisa" THEN RAISE EXCEPTION 'RefundAllocation: more than the payment held'; END IF;
      IF (r."source" = 'deposit-excess' AND NEW."way" = 'cash' AND NEW."method" IN ('bkash', 'nagad') AND NEW."cashReason" IS DISTINCT FROM 'deposit-excess')
         OR (r."source" <> 'deposit-excess' AND NEW."cashReason" = 'deposit-excess') THEN
        RAISE EXCEPTION 'RefundAllocation: wallet money paid back in cash as the excess says so (deposit-excess), and only then';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM "Task" WHERE "id" = r."caseTaskId" AND "kind" = 'payment-reconciliation' AND "focusId" = NEW."paymentId"
                        AND NEW."amountPaisa" <= coalesce(("detail"->>'amountPaisa')::int, 0)) THEN
      RAISE EXCEPTION 'RefundAllocation: a reconciliation refund goes back against the case''s payment, at most its amount';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."tenantId", NEW."refundId", NEW."paymentId", NEW."method", NEW."amountPaisa", NEW."gatewayRef", NEW."gatewayTrxId") IS DISTINCT FROM (OLD."tenantId", OLD."refundId", OLD."paymentId", OLD."method", OLD."amountPaisa", OLD."gatewayRef", OLD."gatewayTrxId") THEN
    RAISE EXCEPTION 'RefundAllocation %: what goes back against which payment never changes', OLD."id";
  END IF;
  IF OLD."status" = 'paid' THEN
    IF OLD."reconcileTaskId" IS NULL AND (to_jsonb(NEW) - 'reconcileTaskId') = (to_jsonb(OLD) - 'reconcileTaskId') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'RefundAllocation %: a paid allocation is never changed', OLD."id";
  END IF;
  IF r."status" <> 'approved' THEN RAISE EXCEPTION 'RefundAllocation %: nothing is paid out before approval', OLD."id"; END IF;
  IF NEW."needsReconciliation" < OLD."needsReconciliation" THEN RAISE EXCEPTION 'RefundAllocation %: the reconciliation flag is never taken off', OLD."id"; END IF;
  IF NEW."way" IS DISTINCT FROM OLD."way" OR NEW."cashReason" IS DISTINCT FROM OLD."cashReason" THEN
    IF NOT (OLD."way" = 'gateway' AND NEW."way" = 'cash' AND NEW."cashReason" = 'gateway-failed' AND OLD."gatewayFailedAt" IS NOT NULL AND OLD."status" = 'open') THEN
      RAISE EXCEPTION 'RefundAllocation %: the way back changes only to cash after the gateway refund failed', OLD."id";
    END IF;
  END IF;

  IF OLD."status" = 'open' AND NEW."status" = 'paying' THEN
    IF NOT lab_actor_ok(NEW."claimedById") THEN RAISE EXCEPTION 'RefundAllocation %: claimed by someone other than the signed-in user', OLD."id"; END IF;
  ELSIF OLD."status" = 'paying' AND NEW."status" = 'open' THEN
    IF NEW."gatewayFailedAt" IS NULL OR NEW."failReason" IS NULL THEN RAISE EXCEPTION 'RefundAllocation %: back to open only with why the gateway refused', OLD."id"; END IF;
  ELSIF OLD."status" = 'paying' AND NEW."status" = 'paid' THEN
    IF NEW."paidById" IS DISTINCT FROM OLD."claimedById" THEN RAISE EXCEPTION 'RefundAllocation %: a gateway refund is paid by whoever claimed it', OLD."id"; END IF;
  ELSIF OLD."status" = 'open' AND NEW."status" = 'paid' THEN
    IF NEW."way" = 'gateway' THEN RAISE EXCEPTION 'RefundAllocation %: a gateway refund is claimed first', OLD."id"; END IF;
    IF NOT lab_actor_ok(NEW."paidById") THEN RAISE EXCEPTION 'RefundAllocation %: paid by someone other than the signed-in user', OLD."id"; END IF;
    IF NEW."way" = 'cash' AND NOT EXISTS (SELECT 1 FROM "Shift" sh WHERE sh."id" = NEW."shiftId" AND sh."status" = 'open' AND sh."cashierId" = NEW."paidById" AND sh."organizationId" = r."organizationId") THEN
      RAISE EXCEPTION 'RefundAllocation %: cash leaves the open shift of the person paying it', OLD."id";
    END IF;
  ELSIF NEW."status" = OLD."status" THEN
    IF OLD."status" = 'paying' THEN RAISE EXCEPTION 'RefundAllocation %: a claimed gateway refund waits for its answer', OLD."id"; END IF;
    IF (to_jsonb(NEW) - ARRAY['way', 'cashReason', 'gatewayFailedAt', 'failReason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['way', 'cashReason', 'gatewayFailedAt', 'failReason']) THEN
      RAISE EXCEPTION 'RefundAllocation %: an open allocation changes only its way back after a failure', OLD."id";
    END IF;
  ELSE
    RAISE EXCEPTION 'RefundAllocation %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ───── B11: the discharge summary, its medicines, its print, the patient app ─────
ALTER TABLE "MedicationRequest" DROP CONSTRAINT medication_request_kind;
ALTER TABLE "MedicationRequest" ADD CONSTRAINT medication_request_kind CHECK ("kind" IN ('opd', 'inpatient', 'discharge'));
-- medicines on discharge are written like a prescription (dose, meal, days, quantity), never timed slots or PRN
ALTER TABLE "MedicationRequest" ADD CONSTRAINT medication_request_discharge CHECK ("kind" <> 'discharge' OR ("orderStatus" = 'active' AND NOT "prn" AND cardinality("times") = 0));
ALTER TABLE "DocumentCode" DROP CONSTRAINT document_code_shape;
ALTER TABLE "DocumentCode" ADD CONSTRAINT document_code_shape CHECK ("kind" IN ('rx', 'lr', 'ds') AND "verifyCode" ~ '^[0-9A-HJKMNP-TV-Z]{16,}$');
CREATE OR REPLACE FUNCTION document_printable(k text, doc text, tenant text, org text) RETURNS boolean AS $$
  SELECT CASE k
    WHEN 'rx' THEN EXISTS (SELECT 1 FROM "Composition" c WHERE c."id" = doc AND c."tenantId" = tenant AND c."organizationId" = org
                             AND c."kind" = 'consultation-note' AND c."status" IN ('final', 'amended'))
    WHEN 'lr' THEN EXISTS (SELECT 1 FROM "DiagnosticReport" r WHERE r."id" = doc AND r."tenantId" = tenant AND r."organizationId" = org
                             AND r."supersededById" IS NULL)
    WHEN 'ds' THEN EXISTS (SELECT 1 FROM "Composition" c WHERE c."id" = doc AND c."tenantId" = tenant AND c."organizationId" = org
                             AND c."kind" = 'discharge-summary' AND c."status" IN ('final', 'amended'))
    ELSE false END;
$$ LANGUAGE sql STABLE;
-- The public check of a discharge summary: facility, date, version and status — no clinical content (decision 10).
CREATE OR REPLACE FUNCTION ds_verify_lookup(p_code text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenantId', c."tenantId", 'patientId', c."patientId", 'documentId', c."id",
    'facilityEn', o."name", 'facilityBn', o."nameBn",
    'doctorEn', u."nameEn", 'doctorBn', u."nameBn", 'regBody', c."signerRegBody", 'regNo', c."signerRegNo", 'regVerified', COALESCE(c."signerRegVerified", false),
    'signedAt', c."signedAt", 'version', c."version", 'status', c."status",
    'initials', person_initials(p."nameEn", p."nameBn"), 'sex', p."sex")
  FROM "DocumentCode" d
  JOIN "Composition" c ON c."id" = d."documentId" AND c."tenantId" = d."tenantId"
  JOIN "Organization" o ON o."id" = c."organizationId"
  JOIN "Patient" p ON p."id" = c."patientId"
  LEFT JOIN "User" u ON u."id" = c."signedById"
  WHERE d."verifyCode" = p_code AND d."kind" = 'ds' AND c."kind" = 'discharge-summary'
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION ds_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ds_verify_lookup(text) TO setu_app;
-- The patient app's record names the summary version it made available (frozen like the other references).
CREATE OR REPLACE FUNCTION communication_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Communication %: a message record is never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'preparation' OR NEW."attempts" <> 0 THEN RAISE EXCEPTION 'Communication: a new message starts in preparation'; END IF;
    IF NEW."compositionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Composition" c WHERE c."id" = NEW."compositionId" AND c."patientId" = NEW."patientId" AND c."status" IN ('final', 'amended')) THEN
      RAISE EXCEPTION 'Communication: a document made available is a signed one of this patient';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."patientId", NEW."encounterId", NEW."kind", NEW."channel", NEW."recipientUserId", NEW."toPhone", NEW."templateKey", NEW."text",
      NEW."reportId", NEW."specimenId", NEW."serviceRequestId", NEW."observationId", NEW."createdById", NEW."createdAt", NEW."paymentId", NEW."compositionId")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."patientId", OLD."encounterId", OLD."kind", OLD."channel", OLD."recipientUserId", OLD."toPhone", OLD."templateKey", OLD."text",
      OLD."reportId", OLD."specimenId", OLD."serviceRequestId", OLD."observationId", OLD."createdById", OLD."createdAt", OLD."paymentId", OLD."compositionId") THEN
    RAISE EXCEPTION 'Communication %: what was sent and to whom never changes', OLD."id";
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('preparation>in-progress', 'in-progress>completed', 'in-progress>failed', 'failed>preparation') THEN
    RAISE EXCEPTION 'Communication %: COMMUNICATION cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF NEW."attempts" <> OLD."attempts" + (CASE WHEN NEW."status" = 'in-progress' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'Communication %: each send counts one attempt', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ───── B12: discharge kinds, their step graphs, "left"; the visit's outcome ─────
ALTER TABLE "Discharge" DROP CONSTRAINT discharge_shape;
ALTER TABLE "Discharge" ADD CONSTRAINT discharge_shape CHECK (
  "status" IN ('ordered', 'completed', 'cancelled') AND "kind" IN ('normal', 'lama', 'death')
  AND length(btrim("advice")) >= CASE WHEN "kind" = 'normal' THEN 10 ELSE 3 END
  AND ("kind" = 'normal') = ("detail" IS NULL)
  AND ("status" = 'cancelled') = ("cancelledAt" IS NOT NULL) AND ("status" = 'cancelled') = ("cancelledById" IS NOT NULL)
  AND ("status" <> 'cancelled' OR length(btrim(coalesce("cancelReason", ''))) >= 10)
  AND ("status" = 'completed') = ("completedAt" IS NOT NULL));
-- earlier steps recorded by hand stay as they were; no new hand record (ADR 0018)
ALTER TABLE "DischargeStep" DROP CONSTRAINT discharge_step_shape;
ALTER TABLE "DischargeStep" ADD CONSTRAINT discharge_step_shape CHECK (
  "key" IN ('order', 'summary', 'pharmacy', 'final-bill', 'payment', 'bed-release') AND "status" IN ('waiting', 'in-progress', 'done')
  AND ("status" = 'waiting') = ("startedAt" IS NULL) AND ("status" = 'done') = ("doneAt" IS NOT NULL) AND ("status" = 'done') = ("doneById" IS NOT NULL)
  AND ("takenById" IS NULL) = ("takenAt" IS NULL) AND ("remindedById" IS NULL) = ("remindedAt" IS NULL) AND "reminders" >= 0);
ALTER TABLE "Encounter" ADD CONSTRAINT encounter_outcome CHECK ("outcome" IS NULL OR ("class" = 'ipd' AND "outcome" IN ('lama', 'deceased')));

CREATE OR REPLACE FUNCTION discharge_step_waits(dkind text, k text) RETURNS text[] AS $$
  SELECT CASE
    WHEN k = 'order' THEN ARRAY[]::text[]
    WHEN k IN ('summary', 'pharmacy', 'final-bill') THEN ARRAY['order']
    WHEN k = 'payment' THEN ARRAY['final-bill']
    WHEN k = 'bed-release' AND dkind = 'normal' THEN ARRAY['summary', 'pharmacy', 'payment']
    WHEN k = 'bed-release' AND dkind = 'lama' THEN ARRAY['pharmacy']
    WHEN k = 'bed-release' AND dkind = 'death' THEN ARRAY['order']
  END;
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION discharge_step_waits(k text) RETURNS text[] AS $$ SELECT discharge_step_waits('normal', k); $$ LANGUAGE sql IMMUTABLE;

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
    RAISE EXCEPTION 'Discharge %: the record never changes — cancel it and record again', OLD."id";
  END IF;
  IF OLD."status" <> 'ordered' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Discharge %: % is final', OLD."id", OLD."status"; END IF;
  IF NEW."status" = 'cancelled' AND OLD."status" = 'ordered' THEN
    IF NOT lab_actor_ok(NEW."cancelledById") THEN RAISE EXCEPTION 'Discharge %: cancelled by the signed-in doctor', OLD."id"; END IF;
    IF OLD."kind" = 'death' THEN RAISE EXCEPTION 'Discharge %: a death record is never cancelled', OLD."id"; END IF;
    IF EXISTS (SELECT 1 FROM "DischargeStep" WHERE "dischargeId" = OLD."id" AND "status" = 'done' AND "key" IN ('bed-release', 'final-bill')) THEN
      RAISE EXCEPTION 'Discharge %: the patient left or the final bill is issued — it cannot be cancelled', OLD."id";
    END IF;
  END IF;
  -- ADR 0018: completed when the patient left (or the body moved); the bill and a LAMA summary may follow
  IF NEW."status" = 'completed' AND OLD."status" = 'ordered' AND NOT EXISTS (SELECT 1 FROM "DischargeStep" WHERE "dischargeId" = OLD."id" AND "key" = 'bed-release' AND "status" = 'done') THEN
    RAISE EXCEPTION 'Discharge %: completed when the patient has left', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION discharge_step_guard() RETURNS trigger AS $$
DECLARE d RECORD; open_deps int;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DischargeStep %: never deleted', OLD."id"; END IF;
  SELECT * INTO d FROM "Discharge" WHERE "id" = NEW."dischargeId";
  IF NEW."byHand" AND (TG_OP = 'INSERT' OR NOT OLD."byHand") THEN RAISE EXCEPTION 'DischargeStep: steps are done by their events now — never recorded by hand (ADR 0018)'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."dischargeId", NEW."key", NEW."tenantId") IS DISTINCT FROM (OLD."dischargeId", OLD."key", OLD."tenantId") THEN RAISE EXCEPTION 'DischargeStep %: its discharge and key never change', OLD."id"; END IF;
    -- after the patient left, the steps still open (the bill, a LAMA summary) go on
    IF d."status" NOT IN ('ordered', 'completed') THEN RAISE EXCEPTION 'DischargeStep %: the discharge is %', OLD."id", d."status"; END IF;
    IF OLD."status" = 'done' AND (to_jsonb(NEW) - ARRAY['remindedById', 'remindedAt', 'reminders']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['remindedById', 'remindedAt', 'reminders']) THEN RAISE EXCEPTION 'DischargeStep %: done is final', OLD."id"; END IF;
    IF NOT ((OLD."status" = NEW."status") OR (OLD."status" = 'waiting' AND NEW."status" = 'in-progress') OR (OLD."status" = 'in-progress' AND NEW."status" = 'done')) THEN
      RAISE EXCEPTION 'DischargeStep %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
    END IF;
    IF NEW."status" = 'done' AND OLD."status" <> 'done' AND NOT lab_actor_ok(NEW."doneById") THEN RAISE EXCEPTION 'DischargeStep %: done by the signed-in user', OLD."id"; END IF;
    IF NEW."takenById" IS DISTINCT FROM OLD."takenById" AND NEW."takenById" IS NOT NULL AND NOT lab_actor_ok(NEW."takenById") THEN RAISE EXCEPTION 'DischargeStep %: taken by the signed-in user', OLD."id"; END IF;
    IF NEW."remindedAt" IS DISTINCT FROM OLD."remindedAt" AND (NOT lab_actor_ok(NEW."remindedById") OR NEW."reminders" <> OLD."reminders" + 1) THEN RAISE EXCEPTION 'DischargeStep %: a reminder is counted and signed', OLD."id"; END IF;
  ELSIF d."status" <> 'ordered' THEN RAISE EXCEPTION 'DischargeStep: the discharge is %', d."status";
  END IF;
  IF discharge_step_waits(d."kind", NEW."key") IS NULL OR (d."kind" = 'death' AND NEW."key" IN ('summary', 'pharmacy')) THEN
    RAISE EXCEPTION 'DischargeStep: a % discharge has no % step', d."kind", NEW."key";
  END IF;
  IF NEW."status" <> 'waiting' AND (TG_OP = 'INSERT' OR OLD."status" = 'waiting') THEN
    SELECT count(*) INTO open_deps FROM unnest(discharge_step_waits(d."kind", NEW."key")) w(k)
      WHERE NOT EXISTS (SELECT 1 FROM "DischargeStep" s WHERE s."dischargeId" = NEW."dischargeId" AND s."key" = w.k AND s."status" = 'done');
    IF open_deps > 0 THEN RAISE EXCEPTION 'DischargeStep: % waits for its earlier steps', NEW."key"; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION discharge_has_steps() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM "DischargeStep" WHERE "dischargeId" = NEW."id") <> (CASE NEW."kind" WHEN 'death' THEN 4 ELSE 6 END) THEN
    RAISE EXCEPTION 'Discharge %: has its % steps', NEW."id", CASE NEW."kind" WHEN 'death' THEN 4 ELSE 6 END;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
