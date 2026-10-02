-- Fixes from the security review of the billing follow-ups (ADR 0005). An applied migration is never edited, so the
-- functions are replaced here.

-- H1: a failed wallet payment is retried only on a bill that still takes payments (never on a voided or settled one).
CREATE OR REPLACE FUNCTION payment_guard() RETURNS trigger AS $$
DECLARE st "InvoiceStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment is never deleted'; END IF;
  SELECT "status" INTO st FROM "Invoice" WHERE "id" = NEW."invoiceId";
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'initiated' THEN RAISE EXCEPTION 'Payment: a new payment starts as initiated (PAYMENT machine)'; END IF;
    IF st IS DISTINCT FROM 'issued' AND st IS DISTINCT FROM 'partially-paid' THEN
      RAISE EXCEPTION 'Payment: the bill is % — payments are taken only on an issued bill', st;
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
  IF OLD."status" = 'failed' AND st IS DISTINCT FROM 'issued' AND st IS DISTINCT FROM 'partially-paid' THEN
    RAISE EXCEPTION 'Payment %: the bill is % — a failed payment is not retried', OLD."id", st;
  END IF;
  IF NEW."status" <> 'initiated' AND NEW."attempt" <> OLD."attempt" THEN RAISE EXCEPTION 'Payment %: attempt changes only on retry', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- M2: a line is "not billed here" only through an approved bill-elsewhere Task of this bill that names this line.
CREATE OR REPLACE FUNCTION charge_item_guard() RETURNS trigger AS $$
DECLARE st "InvoiceStatus";
BEGIN
  SELECT "status" INTO st FROM "Invoice" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END);
  IF st IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'ChargeItem: the bill is % — lines change only in a draft', st; END IF;
  IF TG_OP = 'UPDATE' AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" THEN RAISE EXCEPTION 'ChargeItem: a line cannot move to another bill'; END IF;
  IF TG_OP <> 'DELETE' AND NEW."notBilledTaskId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."notBilledTaskId" IS DISTINCT FROM OLD."notBilledTaskId") THEN
    IF NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = NEW."notBilledTaskId" AND t."kind" = 'bill-elsewhere' AND t."status" = 'approved'
                     AND t."focusId" = NEW."invoiceId" AND t."detail"->>'lineId' = NEW."id") THEN
      RAISE EXCEPTION 'ChargeItem %: "not billed here" needs an approved bill-elsewhere approval for this line', NEW."id";
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- L1: a voided bill records as its replacement only an issued bill of the same visit, once.
CREATE OR REPLACE FUNCTION invoice_replacement_ok(p_old "Invoice", p_new_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Invoice" n WHERE n."id" = p_new_id AND n."encounterId" = p_old."encounterId"
                   AND n."id" <> p_old."id" AND n."number" IS NOT NULL AND n."status" NOT IN ('draft', 'cancelled', 'entered-in-error'));
$$;
DO $$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef('invoice_guard'::regproc) INTO src;
  src := replace(src,
    'IF OLD."replacedById" IS NULL AND NEW."replacedById" IS NOT NULL',
    'IF OLD."replacedById" IS NULL AND NEW."replacedById" IS NOT NULL AND invoice_replacement_ok(OLD, NEW."replacedById")');
  IF position('invoice_replacement_ok' in src) = 0 THEN RAISE EXCEPTION 'invoice_guard: replacement check not applied'; END IF;
  EXECUTE src;
END $$;
