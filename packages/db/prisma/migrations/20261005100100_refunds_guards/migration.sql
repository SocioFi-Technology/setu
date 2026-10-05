-- Refunds (ADR 0013): the database enforces the REFUND machine, the caps (per bill line, per payment, per bill), the
-- way the money goes back, who decides, the bill's refunded money, void after a full refund, returns into quarantine
-- and resale back to the counter. The app role cannot delete anything here.
REVOKE DELETE ON "Refund", "RefundLine", "RefundAllocation", "RefundVoucher", "RefundVoucherPrint", "StockResale" FROM setu_app;
REVOKE UPDATE ON "RefundLine", "RefundVoucher", "RefundVoucherPrint", "StockResale" FROM setu_app;

-- ───── shapes ─────
ALTER TABLE "Refund" ADD CONSTRAINT refund_shape CHECK (
  "source" IN ('bill', 'reconciliation')
  AND "category" IN ('cancelled-test', 'wrong-dispense', 'overpayment', 'patient-request', 'other')
  AND length(btrim("reason")) >= 10
  AND "amountPaisa" > 0 AND "amountPaisa" <= 1000000000 AND "netPaisa" >= 0 AND "vatPaisa" >= 0 AND "netPaisa" + "vatPaisa" = "amountPaisa"
  AND (("source" = 'reconciliation') = ("caseTaskId" IS NOT NULL))
  AND (("source" = 'reconciliation') = ("category" = 'overpayment'))
  AND ("source" = 'bill' OR "vatPaisa" = 0)
  AND ("recipientRelation" IS NULL OR "recipientRelation" IN ('self', 'spouse', 'parent', 'child', 'sibling', 'other-relative', 'other'))
  AND ("recipientPhone" IS NULL OR "recipientPhone" ~ '^1[3-9][0-9]{8}$')
  AND ("recipientName" IS NULL OR length(btrim("recipientName")) BETWEEN 2 AND 80)
  AND (("status" = 'paid') = ("paidAt" IS NOT NULL))
  AND ("status" <> 'paid' OR ("recipientName" IS NOT NULL AND "recipientPhone" IS NOT NULL AND "recipientRelation" IS NOT NULL))
  AND ("status" <> 'rejected' OR length(btrim(coalesce("decisionNote", ''))) >= 10)
  AND (("status" = 'withdrawn') = ("withdrawnAt" IS NOT NULL))
  AND ("status" <> 'withdrawn' OR length(btrim(coalesce("withdrawNote", ''))) >= 10)
);
-- At most one refund per bill is open (requested or approved) at a time.
CREATE UNIQUE INDEX "Refund_one_open_per_bill" ON "Refund" ("invoiceId") WHERE "status" IN ('requested', 'approved');

ALTER TABLE "RefundLine" ADD CONSTRAINT refund_line_shape CHECK (
  "netPaisa" >= 0 AND "vatPaisa" >= 0 AND "totalPaisa" = "netPaisa" + "vatPaisa" AND "totalPaisa" > 0 AND ("units" IS NULL OR "units" > 0));
CREATE UNIQUE INDEX "RefundLine_once_per_bill_line" ON "RefundLine" ("refundId", "chargeItemId");

ALTER TABLE "RefundAllocation" ADD CONSTRAINT refund_allocation_shape CHECK (
  "amountPaisa" > 0
  AND "way" IN ('cash', 'gateway', 'manual') AND "status" IN ('open', 'paying', 'paid')
  AND ("cashReason" IS NULL OR "cashReason" IN ('no-wallet-access', 'gateway-failed'))
  -- the way back (decision 2): cash → cash; card / bank → by hand, or cash (flagged); a wallet → its gateway, by hand,
  -- or cash with why
  AND ("method" <> 'cash' OR ("way" = 'cash' AND "cashReason" IS NULL))
  AND ("method" NOT IN ('card', 'bank') OR ("way" IN ('manual', 'cash') AND "cashReason" IS NULL))
  AND ("method" NOT IN ('bkash', 'nagad') OR "way" <> 'cash' OR "cashReason" IS NOT NULL)
  AND ("way" = 'cash' OR "cashReason" IS NULL)
  AND (("status" = 'paid') = ("paidAt" IS NOT NULL AND "paidById" IS NOT NULL))
  AND ("status" <> 'paying' OR ("way" = 'gateway' AND "claimedAt" IS NOT NULL AND "claimedById" IS NOT NULL))
  AND ("status" <> 'paid' OR "way" <> 'cash' OR "shiftId" IS NOT NULL)
  AND ("status" <> 'paid' OR "way" <> 'manual' OR length(btrim(coalesce("reference", ''))) >= 3)
  AND ("status" <> 'paid' OR "way" <> 'gateway' OR "refundTrxId" IS NOT NULL)
  -- by hand, and card / bank money paid back in cash, are checked by the owner against the statement
  AND ("status" <> 'paid' OR NOT ("way" = 'manual' OR ("way" = 'cash' AND "method" IN ('card', 'bank'))) OR "needsReconciliation")
);

-- ───── the refund ─────
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
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Refund %: cannot move from % to % (REFUND machine)', OLD."id", OLD."status", NEW."status";
END $$ LANGUAGE plpgsql;
CREATE TRIGGER refund_guard BEFORE INSERT OR UPDATE OR DELETE ON "Refund" FOR EACH ROW EXECUTE FUNCTION refund_guard();

-- ───── credit-note lines: only with the request, within what is left of the bill line ─────
CREATE OR REPLACE FUNCTION refund_line_guard() RETURNS trigger AS $$
DECLARE r RECORD; c RECORD; s RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'RefundLine is never changed or deleted'; END IF;
  SELECT * INTO r FROM "Refund" WHERE "id" = NEW."refundId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR r."status" <> 'requested' OR r."decidedById" IS NOT NULL OR r."source" <> 'bill' THEN RAISE EXCEPTION 'RefundLine: lines are written with the request of a bill refund'; END IF;
  SELECT * INTO c FROM "ChargeItem" WHERE "id" = NEW."chargeItemId" AND "invoiceId" = r."invoiceId";
  IF NOT FOUND THEN RAISE EXCEPTION 'RefundLine: the line is not on this bill'; END IF;
  IF c."notBilledTaskId" IS NOT NULL THEN RAISE EXCEPTION 'RefundLine: a "Not billed here" line has nothing to refund'; END IF;
  IF (c."source" IN ('dispense', 'sale')) <> (NEW."units" IS NOT NULL) THEN RAISE EXCEPTION 'RefundLine: medicine is refunded by units, a service by amount'; END IF;
  -- what all live refunds take from this bill line, this one included, never exceeds the line
  SELECT coalesce(sum(l."netPaisa"), 0) AS n, coalesce(sum(l."vatPaisa"), 0) AS v, coalesce(sum(l."totalPaisa"), 0) AS t, coalesce(sum(l."units"), 0) AS u
    INTO s FROM "RefundLine" l JOIN "Refund" x ON x."id" = l."refundId"
    WHERE l."chargeItemId" = NEW."chargeItemId" AND x."status" NOT IN ('rejected', 'withdrawn');
  IF s.n + NEW."netPaisa" > c."netPaisa" OR s.v + NEW."vatPaisa" > c."vatPaisa" OR s.t + NEW."totalPaisa" > c."totalPaisa" OR s.u + coalesce(NEW."units", 0) > c."qty" THEN
    RAISE EXCEPTION 'RefundLine: more than is left of the bill line';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER refund_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "RefundLine" FOR EACH ROW EXECUTE FUNCTION refund_line_guard();

-- ───── allocations: against a confirmed payment of the bill (or the case's payment), then paid out once ─────
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
    IF r."source" = 'bill' THEN
      IF p."status" <> 'confirmed' THEN RAISE EXCEPTION 'RefundAllocation: only confirmed money goes back'; END IF;
      SELECT coalesce(sum(a."amountPaisa"), 0) INTO taken FROM "RefundAllocation" a JOIN "Refund" x ON x."id" = a."refundId"
        WHERE a."paymentId" = NEW."paymentId" AND x."source" = 'bill' AND x."status" NOT IN ('rejected', 'withdrawn');
      IF taken + NEW."amountPaisa" > p."amountPaisa" THEN RAISE EXCEPTION 'RefundAllocation: more than the payment held'; END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM "Task" WHERE "id" = r."caseTaskId" AND "kind" = 'payment-reconciliation' AND "focusId" = NEW."paymentId") THEN
      RAISE EXCEPTION 'RefundAllocation: a reconciliation refund goes back against the case''s payment';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."tenantId", NEW."refundId", NEW."paymentId", NEW."method", NEW."amountPaisa") IS DISTINCT FROM (OLD."tenantId", OLD."refundId", OLD."paymentId", OLD."method", OLD."amountPaisa") THEN
    RAISE EXCEPTION 'RefundAllocation %: what goes back against which payment never changes', OLD."id";
  END IF;
  IF OLD."status" = 'paid' THEN
    -- once paid, only the owner's reconciliation task may be attached
    IF OLD."reconcileTaskId" IS NULL AND (to_jsonb(NEW) - 'reconcileTaskId') = (to_jsonb(OLD) - 'reconcileTaskId') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'RefundAllocation %: a paid allocation is never changed', OLD."id";
  END IF;
  IF r."status" <> 'approved' THEN RAISE EXCEPTION 'RefundAllocation %: nothing is paid out before approval', OLD."id"; END IF;
  IF NEW."needsReconciliation" < OLD."needsReconciliation" THEN RAISE EXCEPTION 'RefundAllocation %: the reconciliation flag is never taken off', OLD."id"; END IF;
  -- the way back changes only from a failed gateway refund to cash, with that reason
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
CREATE TRIGGER refund_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON "RefundAllocation" FOR EACH ROW EXECUTE FUNCTION refund_allocation_guard();

-- ───── at commit: a refund adds up, stays within the bill's money, and a paid one has its voucher and returns ─────
CREATE OR REPLACE FUNCTION refund_consistent() RETURNS trigger AS $$
DECLARE rid text; r RECORD; inv RECORD; s RECORD; a RECORD; live bigint; refunded bigint;
BEGIN
  rid := CASE TG_TABLE_NAME WHEN 'Refund' THEN NEW."id" ELSE NEW."refundId" END;
  SELECT * INTO r FROM "Refund" WHERE "id" = rid;
  SELECT * INTO inv FROM "Invoice" WHERE "id" = r."invoiceId";
  SELECT count(*) AS n, coalesce(sum("netPaisa"), 0) AS net, coalesce(sum("vatPaisa"), 0) AS vat, coalesce(sum("totalPaisa"), 0) AS tot INTO s FROM "RefundLine" WHERE "refundId" = rid;
  IF r."source" = 'bill' AND (s.n = 0 OR (s.net, s.vat, s.tot) IS DISTINCT FROM (r."netPaisa"::bigint, r."vatPaisa"::bigint, r."amountPaisa"::bigint)) THEN
    RAISE EXCEPTION 'Refund %: the refund is not the sum of its lines', rid;
  END IF;
  IF r."source" = 'reconciliation' AND s.n > 0 THEN RAISE EXCEPTION 'Refund %: a reconciliation refund has no bill lines', rid; END IF;
  SELECT count(*) AS n, coalesce(sum("amountPaisa"), 0) AS tot, count(*) FILTER (WHERE "status" <> 'paid') AS unpaid INTO a FROM "RefundAllocation" WHERE "refundId" = rid;
  IF a.n = 0 OR a.tot <> r."amountPaisa" THEN RAISE EXCEPTION 'Refund %: the allocations do not add up to the refund', rid; END IF;
  IF r."source" = 'reconciliation' AND a.n <> 1 THEN RAISE EXCEPTION 'Refund %: a reconciliation refund goes back in one piece', rid; END IF;
  -- never more than the confirmed money on the bill
  SELECT coalesce(sum("amountPaisa"), 0) INTO live FROM "Refund" WHERE "invoiceId" = r."invoiceId" AND "source" = 'bill' AND "status" NOT IN ('rejected', 'withdrawn');
  IF live > inv."paidPaisa" THEN RAISE EXCEPTION 'Refund %: more than the confirmed money on the bill', rid; END IF;
  -- the bill's refunded money is the sum of what was paid out of its bill refunds
  SELECT coalesce(sum(x."amountPaisa"), 0) INTO refunded FROM "RefundAllocation" x JOIN "Refund" y ON y."id" = x."refundId"
    WHERE y."invoiceId" = r."invoiceId" AND y."source" = 'bill' AND x."status" = 'paid';
  IF refunded <> inv."refundedPaisa" THEN RAISE EXCEPTION 'Invoice %: refunded % is not what its refunds paid out %', inv."id", inv."refundedPaisa", refunded; END IF;
  IF (r."status" = 'paid') <> (a.unpaid = 0) THEN RAISE EXCEPTION 'Refund %: paid exactly when every allocation is paid', rid; END IF;
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
CREATE CONSTRAINT TRIGGER refund_consistent AFTER INSERT OR UPDATE ON "Refund" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_consistent();
CREATE CONSTRAINT TRIGGER refund_line_consistent AFTER INSERT ON "RefundLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_consistent();
CREATE CONSTRAINT TRIGGER refund_allocation_consistent AFTER INSERT OR UPDATE ON "RefundAllocation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_consistent();

-- ───── the voucher: made in the paying transaction, immutable, numbered RF/yy/nnnn ─────
CREATE OR REPLACE FUNCTION refund_voucher_guard() RETURNS trigger AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION '%: a refund voucher is never changed or deleted', TG_TABLE_NAME; END IF;
  SELECT * INTO r FROM "Refund" WHERE "id" = NEW."refundId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR r."status" NOT IN ('approved', 'paid') OR r."organizationId" <> NEW."organizationId" OR r."invoiceId" <> NEW."invoiceId"
     OR r."patientId" IS DISTINCT FROM NEW."patientId" OR r."amountPaisa" <> NEW."amountPaisa" THEN
    RAISE EXCEPTION 'RefundVoucher: the voucher of an approved refund, for its amount';
  END IF;
  IF NOT lab_actor_ok(NEW."createdById") AND current_setting('app.user_id', true) IS NOT NULL AND current_setting('app.user_id', true) <> '' THEN
    RAISE EXCEPTION 'RefundVoucher: made by someone other than the signed-in user';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER refund_voucher_guard BEFORE INSERT OR UPDATE OR DELETE ON "RefundVoucher" FOR EACH ROW EXECUTE FUNCTION refund_voucher_guard();
CREATE OR REPLACE FUNCTION refund_voucher_print_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: a voucher print is never changed or deleted', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER refund_voucher_print_immutable BEFORE UPDATE OR DELETE ON "RefundVoucherPrint" FOR EACH ROW EXECUTE FUNCTION refund_voucher_print_immutable();
ALTER TABLE "RefundVoucher" ADD CONSTRAINT refund_voucher_shape CHECK ("verifyCode" ~ '^[0-9A-HJKMNP-TV-Z]{20,}$' AND "number" ~ '^RF/[0-9]{2}/[0-9]{4,}$' AND "amountPaisa" > 0);
ALTER TABLE "RefundVoucherPrint" ADD CONSTRAINT refund_voucher_print_shape CHECK (
  "copy" >= 0 AND "format" IN ('a5', 'thermal') AND "lang" IN ('both', 'bn', 'en') AND (("copy" = 0) = ("reason" IS NULL)));

-- The public verify page (no session) reads only this: facility, voucher number, date, amount. Never the patient.
CREATE OR REPLACE FUNCTION refund_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('facilityEn', o."name", 'facilityBn', o."nameBn", 'number', v."number", 'createdAt', v."createdAt", 'amountPaisa', v."amountPaisa")
  FROM "RefundVoucher" v JOIN "Organization" o ON o."id" = v."organizationId"
  WHERE v."verifyCode" = p_code
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION refund_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refund_verify_lookup(text) TO setu_app;

-- ───── the bill (ADR 0005 addendum): refunded money, and void once all of it went back ─────
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
    IF EXISTS (SELECT 1 FROM "ChargeItem" c WHERE c."invoiceId" = NEW."id" AND c."source" IN ('dispense', 'sale') AND c."qty" >
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

-- ───── returns (ADR 0009 addendum) ─────
-- A return row reverses one dispense row of the same visit and line, for units a paid-out refund line names; the
-- original row is never edited. Other actions keep their checks (a signed, current prescription).
CREATE OR REPLACE FUNCTION medication_dispense_guard() RETURNS trigger AS $$
DECLARE c RECORD; r RECORD; o RECORD; l RECORD; back bigint;
BEGIN
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'MedicationDispense: recorded by someone other than the signed-in user'; END IF;
  IF NEW."action" = 'return' THEN
    SELECT * INTO o FROM "MedicationDispense" WHERE "id" = NEW."returnOfId" AND "tenantId" = NEW."tenantId" AND "action" = 'dispense';
    IF NOT FOUND OR (o."encounterId", o."patientId", o."organizationId", o."requestId", o."compositionId", o."prescribedKey", o."medicineKey")
       IS DISTINCT FROM (NEW."encounterId", NEW."patientId", NEW."organizationId", NEW."requestId", NEW."compositionId", NEW."prescribedKey", NEW."medicineKey") THEN
      RAISE EXCEPTION 'MedicationDispense: a return reverses a dispense of the same visit and line';
    END IF;
    SELECT rl.*, x."status" AS refund_status INTO l FROM "RefundLine" rl JOIN "Refund" x ON x."id" = rl."refundId" JOIN "ChargeItem" ci ON ci."id" = rl."chargeItemId"
      WHERE rl."id" = NEW."refundLineId" AND ci."sourceId" = o."id" AND ci."source" = 'dispense';
    IF NOT FOUND OR l.refund_status NOT IN ('approved', 'paid') OR l."units" <> NEW."qty" THEN RAISE EXCEPTION 'MedicationDispense: a return is paid back by its refund line'; END IF;
    SELECT coalesce(sum("qty"), 0) INTO back FROM "MedicationDispense" WHERE "returnOfId" = o."id" AND "action" = 'return';
    IF NEW."qty" <= 0 OR back + NEW."qty" > o."qty" THEN RAISE EXCEPTION 'MedicationDispense: more returned than was given'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."returnOfId" IS NOT NULL OR NEW."refundLineId" IS NOT NULL THEN RAISE EXCEPTION 'MedicationDispense: only a return points at a dispense'; END IF;
  SELECT * INTO c FROM "Composition" WHERE "id" = NEW."compositionId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR c."status" NOT IN ('final', 'amended') OR c."encounterId" <> NEW."encounterId" OR c."patientId" <> NEW."patientId" OR c."organizationId" <> NEW."organizationId" THEN
    RAISE EXCEPTION 'MedicationDispense: only a signed, current prescription of this visit is dispensed';
  END IF;
  SELECT * INTO r FROM "MedicationRequest" WHERE "id" = NEW."requestId" AND "compositionId" = NEW."compositionId";
  IF NOT FOUND OR r."medicineKey" <> NEW."prescribedKey" THEN RAISE EXCEPTION 'MedicationDispense: the line is not on this prescription'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
ALTER TABLE "MedicationDispense" DROP CONSTRAINT medication_dispense_shape;
ALTER TABLE "MedicationDispense" ADD CONSTRAINT medication_dispense_shape CHECK (
  ("action" IN ('dispense', 'return') AND "qty" > 0) OR ("action" = 'decline' AND "qty" = 0 AND char_length(btrim(coalesce("reason", ''))) >= 10));
ALTER TABLE "StockMove" ADD CONSTRAINT stock_move_return_ref CHECK ("kind" <> 'return' OR ("refType" = 'refund-line' AND "refId" IS NOT NULL AND "qty" > 0));
ALTER TABLE "MedicationDispense" ADD CONSTRAINT medication_dispense_action CHECK ("action" IN ('dispense', 'decline', 'return') AND (("action" = 'return') = ("returnOfId" IS NOT NULL AND "refundLineId" IS NOT NULL)));

-- Stock moves the app writes are backed (purchasing review): + return — into a quarantine batch of the same medicine,
-- batch, expiry and prices as the bill line's batch, exactly the units of a refund line being paid out, once;
-- + a transfer out of quarantine is backed by a pharmacist's (owner's) resale decision.
CREATE OR REPLACE FUNCTION stock_move_backed() RETURNS trigger AS $$
DECLARE n int; total bigint; kinds int; b RECORD; src RECORD; rs RECORD;
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
    SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId";
    IF b."location" = 'quarantine' THEN
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
    SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId";
    SELECT sb.* INTO src FROM "RefundLine" l JOIN "Refund" x ON x."id" = l."refundId" JOIN "ChargeItem" ci ON ci."id" = l."chargeItemId" JOIN "StockBatch" sb ON sb."id" = ci."batchId"
      WHERE NEW."refType" = 'refund-line' AND l."id" = NEW."refId" AND l."units" = NEW."qty" AND x."status" IN ('approved', 'paid') AND x."organizationId" = NEW."organizationId";
    IF NOT FOUND OR b."location" <> 'quarantine'
       OR (b."medicineKey", b."batchNo", b."expiry", b."costPaisa", b."mrpPaisa", b."vatRateBp") IS DISTINCT FROM (src."medicineKey", src."batchNo", src."expiry", src."costPaisa", src."mrpPaisa", src."vatRateBp") THEN
      RAISE EXCEPTION 'StockMove %: a return comes into quarantine from a refund line, the units it names', NEW."id";
    END IF;
    IF (SELECT count(*) FROM "StockMove" WHERE "refType" = 'refund-line' AND "refId" = NEW."refId") <> 1 THEN
      RAISE EXCEPTION 'StockMove %: a refund line''s medicine comes back once', NEW."id";
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION stock_resale_guard() RETURNS trigger AS $$
DECLARE f RECORD; t RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'StockResale is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'StockResale: decided by someone other than the signed-in user'; END IF;
  SELECT * INTO f FROM "StockBatch" WHERE "id" = NEW."fromBatchId" AND "tenantId" = NEW."tenantId";
  SELECT * INTO t FROM "StockBatch" WHERE "id" = NEW."toBatchId" AND "tenantId" = NEW."tenantId";
  IF f."id" IS NULL OR t."id" IS NULL OR f."location" <> 'quarantine' OR t."location" <> 'counter' OR f."organizationId" <> NEW."organizationId" OR t."organizationId" <> NEW."organizationId" THEN
    RAISE EXCEPTION 'StockResale: from quarantine to the counter of this facility';
  END IF;
  IF NOT NEW."unopened" OR length(btrim(NEW."reason")) < 10 OR NEW."qty" <= 0 OR NEW."qty" > f."qtyOnHand" THEN
    RAISE EXCEPTION 'StockResale: unopened, with a reason, at most what quarantine holds';
  END IF;
  IF f."expiry" < to_char((now() AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') THEN RAISE EXCEPTION 'StockResale: an expired batch never goes back to the counter'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_resale_guard BEFORE INSERT OR UPDATE OR DELETE ON "StockResale" FOR EACH ROW EXECUTE FUNCTION stock_resale_guard();
