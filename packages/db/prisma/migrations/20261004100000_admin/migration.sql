-- Admin session 1 (ADR 0010): facility status and settings, first-sign-in and session generation on users, the price-list change history.
-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('setup', 'live');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "liveAt" TIMESTAMP(3),
ADD COLUMN     "paymentMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "receiptFormat" TEXT,
ADD COLUMN     "rxFormat" TEXT,
ADD COLUMN     "smsTestPhone" TEXT,
ADD COLUMN     "smsTestedAt" TIMESTAMP(3),
ADD COLUMN     "status" "OrgStatus" NOT NULL DEFAULT 'live';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedReason" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sessionGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tempPasswordExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChargePriceChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "oldUnitPaisa" INTEGER,
    "newUnitPaisa" INTEGER NOT NULL,
    "oldVatRateBp" INTEGER,
    "newVatRateBp" INTEGER NOT NULL,
    "reason" TEXT,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargePriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChargePriceChange_tenantId_organizationId_at_idx" ON "ChargePriceChange"("tenantId", "organizationId", "at");

-- CreateIndex
CREATE INDEX "ChargePriceChange_definitionId_idx" ON "ChargePriceChange"("definitionId");


-- Facilities that existed before go-live existed are live, with the formats and payment methods they used.
UPDATE "Organization" SET "status" = 'live', "liveAt" = coalesce("liveAt", now()), "receiptFormat" = coalesce("receiptFormat", 'a5'), "rxFormat" = coalesce("rxFormat", 'a5'),
  "paymentMethods" = CASE WHEN cardinality("paymentMethods") = 0 THEN ARRAY['cash', 'card', 'bank', 'bkash', 'nagad'] ELSE "paymentMethods" END;
ALTER TABLE "Organization" ALTER COLUMN "paymentMethods" SET NOT NULL;
ALTER TABLE "Organization" ADD CONSTRAINT organization_settings CHECK (
  "paymentMethods" <@ ARRAY['cash', 'card', 'bank', 'bkash', 'nagad']
  AND ("receiptFormat" IS NULL OR "receiptFormat" IN ('a5', 'thermal')) AND ("rxFormat" IS NULL OR "rxFormat" IN ('a5', 'a4'))
  AND ("status" = 'setup' OR "liveAt" IS NOT NULL)
  AND "cashierDiscountLimitPaisa" BETWEEN 0 AND 1000000000 AND "approverLimitPaisa" BETWEEN 0 AND 1000000000
  AND "cashierDiscountLimitBp" BETWEEN 0 AND 5000 AND "cashierDiscountLimitPaisa" <= "approverLimitPaisa");
-- a live facility never goes back to setup
CREATE OR REPLACE FUNCTION organization_status_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'live' AND NEW."status" = 'setup' THEN RAISE EXCEPTION 'Organization %: a live facility never goes back to setup', OLD."id"; END IF;
  IF OLD."liveAt" IS NOT NULL AND NEW."liveAt" IS DISTINCT FROM OLD."liveAt" THEN RAISE EXCEPTION 'Organization %: the go-live time never changes', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER organization_status_guard BEFORE UPDATE ON "Organization" FOR EACH ROW EXECUTE FUNCTION organization_status_guard();

-- the session generation only goes up (a bumped generation is never undone)
CREATE OR REPLACE FUNCTION user_generation_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."sessionGeneration" < OLD."sessionGeneration" THEN RAISE EXCEPTION 'User %: the session generation never goes down', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER user_generation_guard BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION user_generation_guard();

-- Row-level security for the new table (same loop as rls.sql).
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

-- ───── the price-list history is append-only, written by the signed-in user ─────
ALTER TABLE "ChargePriceChange" ADD CONSTRAINT charge_price_change_shape CHECK ("newUnitPaisa" BETWEEN 0 AND 1000000000 AND "newVatRateBp" BETWEEN 0 AND 10000
  AND ("oldUnitPaisa" IS NULL OR char_length(btrim(coalesce("reason", ''))) >= 10));
REVOKE UPDATE, DELETE ON "ChargePriceChange" FROM setu_app;
CREATE TRIGGER charge_price_change_immutable BEFORE UPDATE OR DELETE ON "ChargePriceChange" FOR EACH ROW EXECUTE FUNCTION pharmacy_record_immutable();
CREATE OR REPLACE FUNCTION charge_price_change_actor() RETURNS trigger AS $$
BEGIN
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'ChargePriceChange: recorded by someone other than the signed-in user'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER charge_price_change_actor BEFORE INSERT ON "ChargePriceChange" FOR EACH ROW EXECUTE FUNCTION charge_price_change_actor();

-- A price or VAT change by the app is recorded in the same transaction (checked at commit); so is a new item.
CREATE OR REPLACE FUNCTION charge_definition_priced() RETURNS trigger AS $$
BEGIN
  IF current_user <> 'setu_app' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND (NEW."unitPaisa", NEW."vatRateBp") IS NOT DISTINCT FROM (OLD."unitPaisa", OLD."vatRateBp") THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ChargePriceChange" c WHERE c."definitionId" = NEW."id" AND c.xmin = pg_current_xact_id()::xid
                   AND c."newUnitPaisa" = NEW."unitPaisa" AND c."newVatRateBp" = NEW."vatRateBp"
                   AND (TG_OP = 'INSERT' OR (c."oldUnitPaisa" IS NOT DISTINCT FROM OLD."unitPaisa" AND c."oldVatRateBp" IS NOT DISTINCT FROM OLD."vatRateBp"))) THEN
    RAISE EXCEPTION 'ChargeItemDefinition %: a price is set or changed only with its history row', NEW."code";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER charge_definition_priced AFTER INSERT OR UPDATE ON "ChargeItemDefinition" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION charge_definition_priced();
REVOKE DELETE ON "ChargeItemDefinition" FROM setu_app;

-- Login: the one pre-tenant read also returns what the first sign-in and the session generation need.
CREATE OR REPLACE FUNCTION auth_login_lookup(p_phones text[], p_email text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', u."id", 'tenantId', u."tenantId", 'nameBn', u."nameBn", 'nameEn', u."nameEn",
    'phone', u."phone", 'email', u."email", 'passwordHash', u."passwordHash", 'plan', t."plan",
    'mustChangePassword', u."mustChangePassword", 'tempPasswordExpiresAt', u."tempPasswordExpiresAt", 'sessionGeneration', u."sessionGeneration",
    'roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('organizationId', r."organizationId", 'organizationName', o."name", 'role', r."role") ORDER BY r."id"), '[]'::jsonb)
              FROM "PractitionerRole" r JOIN "Organization" o ON o."id" = r."organizationId" WHERE r."userId" = u."id")
  )), '[]'::jsonb)
  FROM "User" u JOIN "Tenant" t ON t."id" = u."tenantId"
  WHERE u."active" AND (u."phone" = ANY (p_phones) OR (p_email IS NOT NULL AND u."email" = p_email));
$$;
REVOKE ALL ON FUNCTION auth_login_lookup(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login_lookup(text[], text) TO setu_app;
