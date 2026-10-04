-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "executeClaimedAt" TIMESTAMP(3),
ADD COLUMN     "linkCode" TEXT,
ADD COLUMN     "providerSignature" TEXT;

-- CreateTable
CREATE TABLE "GatewayToken" (
    "provider" TEXT NOT NULL,
    "idToken" TEXT NOT NULL,
    "idExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayToken_pkey" PRIMARY KEY ("provider")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_linkCode_key" ON "Payment"("linkCode");


-- ADR 0011: the gateway token is not the app's to read or write directly
REVOKE ALL ON TABLE "GatewayToken" FROM setu_app;

CREATE OR REPLACE FUNCTION gateway_token_get(p_provider text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('idToken', t."idToken", 'idExpiresAt', t."idExpiresAt", 'refreshToken', t."refreshToken", 'refreshExpiresAt', t."refreshExpiresAt")
  FROM "GatewayToken" t WHERE t."provider" = p_provider;
$$;
REVOKE ALL ON FUNCTION gateway_token_get(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway_token_get(text) TO setu_app;

CREATE OR REPLACE FUNCTION gateway_token_put(p_provider text, p_id text, p_id_exp timestamptz, p_refresh text, p_refresh_exp timestamptz)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO "GatewayToken" ("provider", "idToken", "idExpiresAt", "refreshToken", "refreshExpiresAt", "updatedAt")
  VALUES (p_provider, p_id, p_id_exp AT TIME ZONE 'UTC', p_refresh, p_refresh_exp AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
  ON CONFLICT ("provider") DO UPDATE SET "idToken" = EXCLUDED."idToken", "idExpiresAt" = EXCLUDED."idExpiresAt",
    "refreshToken" = EXCLUDED."refreshToken", "refreshExpiresAt" = EXCLUDED."refreshExpiresAt", "updatedAt" = EXCLUDED."updatedAt";
$$;
REVOKE ALL ON FUNCTION gateway_token_put(text, text, timestamptz, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway_token_put(text, text, timestamptz, text, timestamptz) TO setu_app;

-- the public short link (/v1/pay/<code>): which tenant and payment, nothing else
CREATE OR REPLACE FUNCTION payment_link_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('tenantId', p."tenantId", 'paymentId', p."id") FROM "Payment" p WHERE p."linkCode" = p_code LIMIT 1;
$$;
REVOKE ALL ON FUNCTION payment_link_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_link_lookup(text) TO setu_app;

-- the payments sweep: wallet payments left without a link, or with an execute claimed and never answered
CREATE OR REPLACE FUNCTION payment_sweep_targets(p_before timestamptz)
RETURNS TABLE (tenant_id text, payment_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p."tenantId", p."id" FROM "Payment" p
  WHERE p."method" IN ('bkash', 'nagad') AND p."status" IN ('initiated', 'link-sent', 'waiting-customer')
    AND ((p."status" = 'initiated' AND p."providerRef" IS NULL AND p."statusAt" < p_before AT TIME ZONE 'UTC')
      OR (p."executeClaimedAt" IS NOT NULL AND p."executeClaimedAt" < p_before AT TIME ZONE 'UTC'))
  ORDER BY p."statusAt" LIMIT 200;
$$;
REVOKE ALL ON FUNCTION payment_sweep_targets(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_sweep_targets(timestamptz) TO setu_app;
