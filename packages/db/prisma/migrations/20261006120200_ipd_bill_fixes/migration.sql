-- ADR 0017 (found by the API tests): the running IPD bill is a draft that holds money — its deposits — and may hold
-- more than it has charged so far. The two shape checks that assumed "a draft holds nothing" exempt the IPD draft only;
-- B10 (the final bill) decides how an excess deposit leaves before the bill is issued.
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_paid_matches_status;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_paid_matches_status CHECK (
  ("status" <> 'draft' OR "creditedPaisa" = 0) AND ("status" <> 'draft' OR "paidPaisa" = 0 OR "kind" = 'ipd')
  AND ("status" <> 'issued' OR "paidPaisa" = 0)
  AND ("status" <> 'partially-paid' OR ("paidPaisa" > 0 AND "paidPaisa" < "totalPaisa" - "creditedPaisa"))
  AND ("status" <> 'balanced' OR "paidPaisa" = "totalPaisa" - "creditedPaisa"));
ALTER TABLE "Invoice" DROP CONSTRAINT invoice_amounts;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_amounts CHECK (
  "subtotalPaisa" >= 0 AND "discountPaisa" >= 0 AND "vatPaisa" >= 0 AND "paidPaisa" >= 0 AND "creditedPaisa" >= 0 AND "discountPaisa" <= "subtotalPaisa"
  AND "netPaisa" = "subtotalPaisa" - "discountPaisa" AND "totalPaisa" = "netPaisa" + "vatPaisa"
  AND ("paidPaisa" + "creditedPaisa" <= "totalPaisa" OR ("kind" = 'ipd' AND "status" = 'draft')));
-- One line per source on a bill (ADR 0009) holds for the keyed IPD lines by key instead: a re-priced line, its credit
-- line and every bed day share their source (the order, the dose, the admission).
DROP INDEX "ChargeItem_source_once";
CREATE UNIQUE INDEX "ChargeItem_source_once" ON "ChargeItem"("invoiceId", "sourceId") WHERE "sourceId" IS NOT NULL AND "key" IS NULL;
-- The census only for open inpatient visits (a visit closed by the E2E reset or a data fix posts nothing).
CREATE OR REPLACE FUNCTION bed_day_sweep_targets(p_now timestamptz)
RETURNS TABLE (tenant_id text, admission_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a."tenantId", a."id" FROM "Admission" a JOIN "Encounter" e ON e."id" = a."encounterId" AND e."status" = 'in-progress'
  WHERE a."status" = 'admitted' AND a."invoiceId" IS NOT NULL
    AND ((p_now - interval '1 minute') AT TIME ZONE 'Asia/Dhaka')::date - ((a."admittedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date + 1
        > coalesce((SELECT max(c."dayNo") FROM "ChargeItem" c WHERE c."invoiceId" = a."invoiceId" AND c."source" = 'bed-day'), 0)
  ORDER BY a."admittedAt" LIMIT 200;
$$;
