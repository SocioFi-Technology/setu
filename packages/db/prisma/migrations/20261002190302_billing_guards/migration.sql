-- Slice A6–A7: row-level security, arithmetic checks and state guards for the billing tables created in
-- 20261002190221_billing. (That migration was applied before this SQL could be appended to it, so it lives here; an
-- applied migration is never edited.) Every amount is integer paisa. The rules mirror @setu/domain billing.ts and the
-- INVOICE / PAYMENT machines; the database refuses what the API must never do, for every role.

-- Row-level security for the new tables (same loop as rls.sql; idempotent for the existing ones).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE column_name = 'tenantId' AND table_schema = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;

-- The price list is seeded by the owner; the API only reads it (masters screens come in phase 2).
REVOKE INSERT, UPDATE, DELETE ON "ChargeItemDefinition" FROM setu_app;
-- Provider callbacks are append-only.
REVOKE UPDATE, DELETE ON "ProviderEvent" FROM setu_app;
-- Bills and payments are never deleted (a void / entered-in-error follow-up comes next; never a delete).
REVOKE DELETE ON "Invoice", "Payment" FROM setu_app;

ALTER TABLE "Organization" ADD CONSTRAINT org_billing_limits CHECK (
  "cashierDiscountLimitPaisa" >= 0 AND "cashierDiscountLimitBp" BETWEEN 0 AND 10000 AND "approverLimitPaisa" >= 0);
ALTER TABLE "ChargeItemDefinition" ADD CONSTRAINT charge_def_amounts CHECK ("unitPaisa" >= 0 AND "vatRateBp" BETWEEN 0 AND 10000);

-- ── Invoice ──
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_amounts CHECK (
  "subtotalPaisa" >= 0 AND "discountPaisa" >= 0 AND "vatPaisa" >= 0 AND "paidPaisa" >= 0
  AND "discountPaisa" <= "subtotalPaisa"
  AND "netPaisa" = "subtotalPaisa" - "discountPaisa"
  AND "totalPaisa" = "netPaisa" + "vatPaisa"
  AND "paidPaisa" <= "totalPaisa");
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_discount_shape CHECK (
  "discountPaisa" = 0 OR ("discountCategory" IS NOT NULL AND length(btrim(coalesce("discountReason", ''))) >= 10
                          AND "discountAppliedById" IS NOT NULL AND "discountAppliedAt" IS NOT NULL));
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_issued_shape CHECK (
  "status" = 'draft' OR ("number" IS NOT NULL AND "issuedAt" IS NOT NULL AND "issuedById" IS NOT NULL));
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_paid_matches_status CHECK (
  ("status" <> 'draft' OR "paidPaisa" = 0) AND ("status" <> 'issued' OR "paidPaisa" = 0)
  AND ("status" <> 'partially-paid' OR ("paidPaisa" > 0 AND "paidPaisa" < "totalPaisa"))
  AND ("status" <> 'balanced' OR "paidPaisa" = "totalPaisa"));
-- One bill per visit (a cancelled one would not count; cancelling comes with the void follow-up).
CREATE UNIQUE INDEX "Invoice_one_per_encounter" ON "Invoice" ("tenantId", "encounterId") WHERE "status" <> 'cancelled';

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

  IF OLD."status" = 'draft' THEN
    IF NEW."status" = 'draft' THEN RETURN NEW; END IF;
    IF NEW."status" <> 'issued' THEN RAISE EXCEPTION 'Invoice %: a draft can only be issued (cancel comes with the void follow-up)', OLD."id"; END IF;
    -- Issue: no discount approval still requested (the APPROVAL Task gates issue and therefore payment), every line
    -- priced, at least one line, and the totals are exactly the sums of the line paisa.
    IF EXISTS (SELECT 1 FROM "Task" WHERE "focusId" = NEW."id" AND "kind" = 'discount-approval' AND "status" = 'requested') THEN
      RAISE EXCEPTION 'Invoice %: a discount approval is still requested', OLD."id";
    END IF;
    SELECT count(*), count(*) FILTER (WHERE "unitPaisa" IS NULL) INTO n_lines, n_unpriced FROM "ChargeItem" WHERE "invoiceId" = NEW."id";
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
  IF (NEW."tenantId", NEW."organizationId", NEW."branchId", NEW."patientId", NEW."encounterId", NEW."number",
      NEW."subtotalPaisa", NEW."discountPaisa", NEW."netPaisa", NEW."vatPaisa", NEW."totalPaisa",
      NEW."discountCategory", NEW."discountReason", NEW."discountAppliedById", NEW."discountAppliedAt", NEW."discountTaskId",
      NEW."rev", NEW."createdById", NEW."createdAt", NEW."issuedById", NEW."issuedAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."organizationId", OLD."branchId", OLD."patientId", OLD."encounterId", OLD."number",
      OLD."subtotalPaisa", OLD."discountPaisa", OLD."netPaisa", OLD."vatPaisa", OLD."totalPaisa",
      OLD."discountCategory", OLD."discountReason", OLD."discountAppliedById", OLD."discountAppliedAt", OLD."discountTaskId",
      OLD."rev", OLD."createdById", OLD."createdAt", OLD."issuedById", OLD."issuedAt") THEN
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
CREATE TRIGGER invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION invoice_guard();

-- ── ChargeItem (bill lines) ──
ALTER TABLE "ChargeItem" ADD CONSTRAINT charge_item_amounts CHECK (
  "qty" BETWEEN 1 AND 999 AND ("unitPaisa" IS NULL OR "unitPaisa" >= 0) AND "vatRateBp" BETWEEN 0 AND 10000
  AND "grossPaisa" = coalesce("unitPaisa", 0) * "qty"
  AND "discountPaisa" BETWEEN 0 AND "grossPaisa"
  AND "netPaisa" = "grossPaisa" - "discountPaisa"
  AND "vatPaisa" >= 0
  AND "totalPaisa" = "netPaisa" + "vatPaisa");
ALTER TABLE "ChargeItem" ADD CONSTRAINT charge_item_source CHECK (("source" = 'desk') = ("sourceId" IS NULL));
-- A visit's consultation and each order are billed once per bill.
CREATE UNIQUE INDEX "ChargeItem_source_once" ON "ChargeItem" ("invoiceId", "sourceId") WHERE "sourceId" IS NOT NULL;

CREATE OR REPLACE FUNCTION charge_item_guard() RETURNS trigger AS $$
DECLARE st "InvoiceStatus";
BEGIN
  SELECT "status" INTO st FROM "Invoice" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END);
  IF st IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'ChargeItem: the bill is % — lines change only in a draft', st; END IF;
  IF TG_OP = 'UPDATE' AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" THEN RAISE EXCEPTION 'ChargeItem: a line cannot move to another bill'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER charge_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "ChargeItem" FOR EACH ROW EXECUTE FUNCTION charge_item_guard();

-- ── Payment ──
ALTER TABLE "Payment" ADD CONSTRAINT payment_amounts CHECK (
  "amountPaisa" > 0 AND "attempt" >= 1
  AND (("method" = 'cash') = ("tenderedPaisa" IS NOT NULL))
  AND ("method" <> 'cash' OR ("tenderedPaisa" >= "amountPaisa" AND "changePaisa" = "tenderedPaisa" - "amountPaisa"))
  AND ("method" = 'cash' OR "changePaisa" IS NULL));
ALTER TABLE "Payment" ADD CONSTRAINT payment_wallet_shape CHECK (("method" IN ('bkash', 'nagad')) = ("provider" IS NOT NULL));
ALTER TABLE "Payment" ADD CONSTRAINT payment_confirmed_shape CHECK (
  "status" <> 'confirmed' OR ("confirmedAt" IS NOT NULL
    AND ("method" NOT IN ('card', 'bank') OR length(btrim(coalesce("reference", ''))) > 0)
    AND ("method" NOT IN ('bkash', 'nagad') OR "trxId" IS NOT NULL)));
CREATE INDEX "Payment_supersededRefs" ON "Payment" USING gin ("supersededRefs");

CREATE OR REPLACE FUNCTION payment_guard() RETURNS trigger AS $$
DECLARE st "InvoiceStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'initiated' THEN RAISE EXCEPTION 'Payment: a new payment starts as initiated (PAYMENT machine)'; END IF;
    SELECT "status" INTO st FROM "Invoice" WHERE "id" = NEW."invoiceId";
    IF st IS DISTINCT FROM 'issued' AND st IS DISTINCT FROM 'partially-paid' THEN
      RAISE EXCEPTION 'Payment: the bill is % — payments are taken only on an issued bill', st;
    END IF;
    RETURN NEW;
  END IF;
  -- PAYMENT has no transition out of confirmed: a confirmed payment is frozen entirely.
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
  IF NEW."status" <> 'initiated' AND NEW."attempt" <> OLD."attempt" THEN RAISE EXCEPTION 'Payment %: attempt changes only on retry', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payment_guard BEFORE INSERT OR UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION payment_guard();

-- Provider callbacks arrive without a session. This is the only pre-tenant read they need: which tenant and payment a
-- provider reference belongs to (current attempt or an earlier, superseded one). Nothing else is revealed.
CREATE OR REPLACE FUNCTION payment_ref_lookup(p_provider text, p_ref text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('tenantId', p."tenantId", 'paymentId', p."id", 'superseded', p."providerRef" IS DISTINCT FROM p_ref)
  FROM "Payment" p
  WHERE p."provider" = p_provider AND (p."providerRef" = p_ref OR p_ref = ANY (p."supersededRefs"))
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION payment_ref_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_ref_lookup(text, text) TO setu_app;
