-- refunds_decisions_233_235: a return with no refund part (credit only) has no allocations — "paid when every allocation is
-- paid" applies only when there are allocations.
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
  -- decision 233: a return credits min(value, due) and refunds the rest; a refund refunds all of it (creditPaisa 0)
  IF a.tot <> r."amountPaisa" - r."creditPaisa" THEN RAISE EXCEPTION 'Refund %: the allocations do not add up to the part refunded', rid; END IF;
  IF r."kind" = 'refund' AND a.n = 0 THEN RAISE EXCEPTION 'Refund %: a refund has a payout', rid; END IF;
  -- decision 220: one payout method per refund, paid whole — a gateway refund against one payment, never part-paid
  IF a.ways > 1 OR a.gw > 1 THEN RAISE EXCEPTION 'Refund %: one refund goes back one way (a gateway refund: one payment)', rid; END IF;
  IF a.paid > 0 AND a.unpaid > 0 THEN RAISE EXCEPTION 'Refund %: a refund is never part-paid', rid; END IF;
  IF r."source" = 'reconciliation' AND a.n <> 1 THEN RAISE EXCEPTION 'Refund %: a reconciliation refund goes back in one piece', rid; END IF;
  -- never more than the confirmed money on the bill
  SELECT coalesce(sum("amountPaisa" - "creditPaisa"), 0) INTO live FROM "Refund" WHERE "invoiceId" = r."invoiceId" AND "source" = 'bill' AND "status" NOT IN ('rejected', 'withdrawn');
  IF live > inv."paidPaisa" THEN RAISE EXCEPTION 'Refund %: more than the confirmed money on the bill', rid; END IF;
  -- the bill's refunded money is the sum of what was paid out of its bill refunds
  SELECT coalesce(sum(x."amountPaisa"), 0) INTO refunded FROM "RefundAllocation" x JOIN "Refund" y ON y."id" = x."refundId"
    WHERE y."invoiceId" = r."invoiceId" AND y."source" = 'bill' AND x."status" = 'paid';
  IF refunded <> inv."refundedPaisa" THEN RAISE EXCEPTION 'Invoice %: refunded % is not what its refunds paid out %', inv."id", inv."refundedPaisa", refunded; END IF;
  SELECT coalesce(sum("creditPaisa"), 0) INTO credited FROM "Refund" WHERE "invoiceId" = r."invoiceId" AND "kind" = 'return' AND "status" = 'paid';
  IF credited <> inv."creditedPaisa" THEN RAISE EXCEPTION 'Invoice %: credited % is not its recorded returns %', inv."id", inv."creditedPaisa", credited; END IF;
  -- a return that only credits has no allocations: its "paid" is the recording itself
  IF a.n > 0 AND (r."status" = 'paid') <> (a.unpaid = 0) THEN RAISE EXCEPTION 'Refund %: paid exactly when every allocation is paid', rid; END IF;
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
