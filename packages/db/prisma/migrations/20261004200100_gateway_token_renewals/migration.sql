-- AlterTable
ALTER TABLE "GatewayToken" ADD COLUMN     "renewals" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
ALTER COLUMN "idToken" DROP NOT NULL,
ALTER COLUMN "idExpiresAt" DROP NOT NULL,
ALTER COLUMN "refreshToken" DROP NOT NULL,
ALTER COLUMN "refreshExpiresAt" DROP NOT NULL;


-- money review (bKash slice): renewal attempts are remembered — failed ones too — so a bKash outage or a stream of
-- refusals can never push us past bKash's two-an-hour limit (which blocks the merchant for an hour)
DROP FUNCTION IF EXISTS gateway_token_put(text, text, timestamptz, text, timestamptz);
CREATE OR REPLACE FUNCTION gateway_token_get(p_provider text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('idToken', t."idToken", 'idExpiresAt', t."idExpiresAt", 'refreshToken', t."refreshToken", 'refreshExpiresAt', t."refreshExpiresAt",
    'renewals', to_jsonb(t."renewals"))
  FROM "GatewayToken" t WHERE t."provider" = p_provider;
$$;
CREATE OR REPLACE FUNCTION gateway_token_put(p_provider text, p_id text, p_id_exp timestamptz, p_refresh text, p_refresh_exp timestamptz, p_renewals timestamptz[])
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO "GatewayToken" ("provider", "idToken", "idExpiresAt", "refreshToken", "refreshExpiresAt", "renewals", "updatedAt")
  VALUES (p_provider, p_id, p_id_exp AT TIME ZONE 'UTC', p_refresh, p_refresh_exp AT TIME ZONE 'UTC',
    ARRAY(SELECT r AT TIME ZONE 'UTC' FROM unnest(p_renewals) r), now() AT TIME ZONE 'UTC')
  ON CONFLICT ("provider") DO UPDATE SET "idToken" = EXCLUDED."idToken", "idExpiresAt" = EXCLUDED."idExpiresAt",
    "refreshToken" = EXCLUDED."refreshToken", "refreshExpiresAt" = EXCLUDED."refreshExpiresAt", "renewals" = EXCLUDED."renewals", "updatedAt" = EXCLUDED."updatedAt";
$$;
REVOKE ALL ON FUNCTION gateway_token_put(text, text, timestamptz, text, timestamptz, timestamptz[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway_token_put(text, text, timestamptz, text, timestamptz, timestamptz[]) TO setu_app;
