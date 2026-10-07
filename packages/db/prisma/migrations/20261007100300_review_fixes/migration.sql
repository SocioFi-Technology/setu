-- Review fixes for B10–B12 (money, clinical safety): the owner approves the excess deposit's refund they asked for (with
-- a note); a death on the ward replaces a discharge already ordered — even after the final bill — never after the
-- patient left.
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
    -- review (B10–B12): the excess deposit's refund is the owner's alone — an owner who issued the bill approves it with a note
    IF self AND ((facility_approvers(OLD."organizationId") <> 1 AND OLD."source" <> 'deposit-excess') OR length(btrim(coalesce(NEW."decisionNote", ''))) < 10) THEN
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
    IF EXISTS (SELECT 1 FROM "DischargeStep" WHERE "dischargeId" = OLD."id" AND "status" = 'done' AND "key" = 'bed-release') THEN
      RAISE EXCEPTION 'Discharge %: the patient left — it cannot be cancelled', OLD."id";
    END IF;
    -- review (B10–B12): after the final bill only a death on the ward replaces it (checked at commit: discharge_replaced)
    IF NEW."cancelReason" IS DISTINCT FROM 'replaced-by-death' AND EXISTS (SELECT 1 FROM "DischargeStep" WHERE "dischargeId" = OLD."id" AND "status" = 'done' AND "key" = 'final-bill') THEN
      RAISE EXCEPTION 'Discharge %: the final bill is issued — it cannot be cancelled', OLD."id";
    END IF;
  END IF;
  -- ADR 0018: completed when the patient left (or the body moved); the bill and a LAMA summary may follow
  IF NEW."status" = 'completed' AND OLD."status" = 'ordered' AND NOT EXISTS (SELECT 1 FROM "DischargeStep" WHERE "dischargeId" = OLD."id" AND "key" = 'bed-release' AND "status" = 'done') THEN
    RAISE EXCEPTION 'Discharge %: completed when the patient has left', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- a discharge cancelled as replaced by a death has the death record of the same admission at commit
CREATE OR REPLACE FUNCTION discharge_replaced() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'cancelled' AND NEW."cancelReason" = 'replaced-by-death' AND NOT EXISTS (
    SELECT 1 FROM "Discharge" d WHERE d."admissionId" = NEW."admissionId" AND d."kind" = 'death' AND d."status" IN ('ordered', 'completed')) THEN
    RAISE EXCEPTION 'Discharge %: replaced by a death record that does not exist', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER discharge_replaced AFTER UPDATE ON "Discharge" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION discharge_replaced();
