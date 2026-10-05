-- Refunds (ADR 0013): fixes from the session 2 security and money reviews.
-- The money goes back against the allocation's own gateway transaction (a reconciliation case's link, not the bill's).
ALTER TABLE "RefundAllocation" ADD COLUMN "gatewayRef" TEXT, ADD COLUMN "gatewayTrxId" TEXT;

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
  -- review: card / bank money paid back in cash is the owner's to approve — derived here, never only from the app
  IF NOT r."needsOwner" AND EXISTS (SELECT 1 FROM "RefundAllocation" WHERE "refundId" = rid AND "method" IN ('card', 'bank') AND "way" = 'cash') THEN
    RAISE EXCEPTION 'Refund %: card / bank money paid back in cash needs the owner', rid;
  END IF;
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

CREATE OR REPLACE FUNCTION refund_line_guard() RETURNS trigger AS $$
DECLARE r RECORD; c RECORD; s RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'RefundLine is never changed or deleted'; END IF;
  SELECT * INTO r FROM "Refund" WHERE "id" = NEW."refundId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR r."status" <> 'requested' OR r."decidedById" IS NOT NULL OR r."source" <> 'bill' THEN RAISE EXCEPTION 'RefundLine: lines are written with the request of a bill refund'; END IF;
  SELECT * INTO c FROM "ChargeItem" WHERE "id" = NEW."chargeItemId" AND "invoiceId" = r."invoiceId";
  IF NOT FOUND THEN RAISE EXCEPTION 'RefundLine: the line is not on this bill'; END IF;
  IF c."notBilledTaskId" IS NOT NULL THEN RAISE EXCEPTION 'RefundLine: a "Not billed here" line has nothing to refund'; END IF;
  -- review: performed = locked — the consultation of a finished visit, a test whose specimen was collected
  IF c."source" = 'consultation' THEN RAISE EXCEPTION 'RefundLine: the consultation was given — not refundable'; END IF;
  IF c."source" = 'order' AND EXISTS (SELECT 1 FROM "ServiceRequest" sr WHERE sr."id" = c."sourceId" AND sr."status" IN ('in-progress', 'partially-complete', 'complete')) THEN
    RAISE EXCEPTION 'RefundLine: the test was performed — not refundable';
  END IF;
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
    ELSIF NOT EXISTS (SELECT 1 FROM "Task" WHERE "id" = r."caseTaskId" AND "kind" = 'payment-reconciliation' AND "focusId" = NEW."paymentId"
                        AND NEW."amountPaisa" <= coalesce(("detail"->>'amountPaisa')::int, 0)) THEN
      -- review: never more than the money the case reported
      RAISE EXCEPTION 'RefundAllocation: a reconciliation refund goes back against the case''s payment, at most its amount';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."tenantId", NEW."refundId", NEW."paymentId", NEW."method", NEW."amountPaisa", NEW."gatewayRef", NEW."gatewayTrxId") IS DISTINCT FROM (OLD."tenantId", OLD."refundId", OLD."paymentId", OLD."method", OLD."amountPaisa", OLD."gatewayRef", OLD."gatewayTrxId") THEN
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

CREATE OR REPLACE FUNCTION stock_resale_guard() RETURNS trigger AS $$
DECLARE f RECORD; t RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'StockResale is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'StockResale: decided by someone other than the signed-in user'; END IF;
  -- review: a pharmacist's decision (a controlled drug: the owner's — the sale class lives in the app's drug list)
  IF NOT EXISTS (SELECT 1 FROM "PractitionerRole" pr WHERE pr."userId" = NEW."byId" AND pr."organizationId" = NEW."organizationId" AND pr."role" IN ('pharmacist', 'owner')) THEN
    RAISE EXCEPTION 'StockResale: only a pharmacist (or the owner) releases returned medicine';
  END IF;
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

-- A voucher exists only for a refund that is paid at commit (made in the paying transaction).
CREATE OR REPLACE FUNCTION refund_voucher_paid() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Refund" WHERE "id" = NEW."refundId" AND "status" = 'paid') THEN
    RAISE EXCEPTION 'RefundVoucher: only a paid refund has a voucher';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER refund_voucher_paid AFTER INSERT ON "RefundVoucher" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_voucher_paid();

-- The owner's check of a refund paid by hand: decided by an owner of that facility, never the person who paid it unless
-- they are its only owner (with a note) — decision 223's rule, re-checked here.
CREATE OR REPLACE FUNCTION refund_check_guard() RETURNS trigger AS $$
DECLARE a RECORD; owners int;
BEGIN
  IF NEW."kind" <> 'refund-reconciliation' OR OLD."status" <> 'requested' OR NEW."status" = 'requested' THEN RETURN NEW; END IF;
  IF NEW."decidedById" IS NULL OR NOT lab_actor_ok(NEW."decidedById") THEN RAISE EXCEPTION 'Task %: decided by someone other than the signed-in user', OLD."id"; END IF;
  SELECT x."paidById", y."organizationId" INTO a FROM "RefundAllocation" x JOIN "Refund" y ON y."id" = x."refundId" WHERE x."id" = OLD."focusId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Task %: not a refund check', OLD."id"; END IF;
  IF current_user = 'setu_app' AND NOT EXISTS (SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = NEW."decidedById" AND r."organizationId" = a."organizationId" AND r."role" = 'owner') THEN
    RAISE EXCEPTION 'Task %: the owner checks refunds paid by hand', OLD."id";
  END IF;
  IF NEW."decidedById" = a."paidById" THEN
    SELECT count(DISTINCT r."userId") INTO owners FROM "PractitionerRole" r JOIN "User" u ON u."id" = r."userId" WHERE r."organizationId" = a."organizationId" AND r."role" = 'owner' AND u."active";
    IF owners <> 1 OR length(btrim(coalesce(NEW."decisionNote", ''))) < 10 THEN
      RAISE EXCEPTION 'Task %: never checked by the person who paid it while another owner exists (alone: with a note)', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER refund_check_guard BEFORE UPDATE ON "Task" FOR EACH ROW EXECUTE FUNCTION refund_check_guard();
