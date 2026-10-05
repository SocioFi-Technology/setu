-- Refunds (ADR 0013), payout details found while writing the routes:
-- - a gateway refund is answered after the commit, so who took the money is recorded on the approved refund (once);
-- - a draft over-the-counter sale has moved no stock yet: its sale lines do not block a void (as before);
-- - the payments sweep asks Refund Status for a gateway refund claimed and never answered.
CREATE OR REPLACE FUNCTION refund_guard() RETURNS trigger AS $$
DECLARE inv RECORD; t RECORD; n_open int;
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
    SELECT * INTO t FROM "Task" WHERE "id" = NEW."approvalTaskId";
    IF NOT FOUND OR t."kind" <> 'refund-approval' OR t."status" <> 'requested' OR t."focusId" <> NEW."invoiceId" OR t."requestedById" <> NEW."requestedById" THEN
      RAISE EXCEPTION 'Refund: a refund is requested through its approval task';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."tenantId", NEW."organizationId", NEW."invoiceId", NEW."patientId", NEW."source", NEW."caseTaskId", NEW."category", NEW."reason",
      NEW."amountPaisa", NEW."netPaisa", NEW."vatPaisa", NEW."needsOwner", NEW."approvalTaskId", NEW."requestedById", NEW."requestedAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."organizationId", OLD."invoiceId", OLD."patientId", OLD."source", OLD."caseTaskId", OLD."category", OLD."reason",
      OLD."amountPaisa", OLD."netPaisa", OLD."vatPaisa", OLD."needsOwner", OLD."approvalTaskId", OLD."requestedById", OLD."requestedAt") THEN
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
    IF NEW."decidedById" = OLD."requestedById" THEN RAISE EXCEPTION 'Refund %: never decided by the person who asked', OLD."id"; END IF;
    IF NOT is_stock_approver(NEW."decidedById", OLD."organizationId") THEN RAISE EXCEPTION 'Refund %: only the owner or an admin decides', OLD."id"; END IF;
    IF NEW."status" = 'approved' AND OLD."needsOwner" AND NOT EXISTS (
      SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = NEW."decidedById" AND r."organizationId" = OLD."organizationId" AND r."role" = 'owner') THEN
      RAISE EXCEPTION 'Refund %: this refund is approved by the owner', OLD."id";
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Task" WHERE "id" = OLD."approvalTaskId" AND "status" = NEW."status"::text::"ApprovalStatus" AND "decidedById" = NEW."decidedById") THEN
      RAISE EXCEPTION 'Refund %: decided through its approval task', OLD."id";
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'statusAt', 'rev', 'decidedById', 'decidedAt', 'decisionNote']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'statusAt', 'rev', 'decidedById', 'decidedAt', 'decisionNote']) THEN
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

CREATE OR REPLACE FUNCTION invoice_guard() RETURNS trigger AS $$
DECLARE
  sums record;
  n_lines int;
  n_unpriced int;
  paid int;
  refunded bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invoice is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' THEN RAISE EXCEPTION 'Invoice: a new bill starts as a draft'; END IF;
    IF NEW."refundedPaisa" <> 0 THEN RAISE EXCEPTION 'Invoice: a new bill has nothing refunded'; END IF;
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
  IF (to_jsonb(NEW) - ARRAY['status', 'paidPaisa', 'refundedPaisa', 'statusAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'paidPaisa', 'refundedPaisa', 'statusAt']) THEN
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

CREATE OR REPLACE FUNCTION refund_sweep_targets(p_before timestamptz)
RETURNS TABLE (tenant_id text, allocation_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a."tenantId", a."id" FROM "RefundAllocation" a
  WHERE a."status" = 'paying' AND a."claimedAt" < p_before AT TIME ZONE 'UTC'
  ORDER BY a."claimedAt" LIMIT 200;
$$;
REVOKE ALL ON FUNCTION refund_sweep_targets(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refund_sweep_targets(timestamptz) TO setu_app;
