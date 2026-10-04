-- AlterTable
ALTER TABLE "Communication" ALTER COLUMN "deliveryConfirmed" SET DEFAULT false;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "smsTestError" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "supersededLinkCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];


-- review (SMS slice): an earlier attempt's short link says "ended"
CREATE OR REPLACE FUNCTION payment_link_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('tenantId', p."tenantId", 'paymentId', p."id", 'superseded', p."linkCode" IS DISTINCT FROM p_code)
  FROM "Payment" p WHERE p."linkCode" = p_code OR p_code = ANY (p."supersededLinkCodes") LIMIT 1;
$$;
CREATE INDEX IF NOT EXISTS "Payment_supersededLinkCodes_idx" ON "Payment" USING GIN ("supersededLinkCodes");
