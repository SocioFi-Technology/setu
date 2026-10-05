-- Refunds (ADR 0013): fixes found by the API tests.
-- refund_consistent: the trigger runs on Refund, RefundLine and RefundAllocation; only the last two have "refundId".
CREATE OR REPLACE FUNCTION refund_consistent() RETURNS trigger AS $$
DECLARE rid text; r RECORD; inv RECORD; s RECORD; a RECORD; live bigint; refunded bigint;
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

-- ADR 0005 addendum: a voided bill may have held money — once all of it went back (paid = refunded), not "paid = 0".
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_void_shape;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_void_shape CHECK (
  (("status" = 'entered-in-error') = ("voidedAt" IS NOT NULL))
  AND ("voidedAt" IS NULL OR ("voidedById" IS NOT NULL AND length(btrim(coalesce("voidReason", ''))) >= 10 AND "paidPaisa" = "refundedPaisa")));
