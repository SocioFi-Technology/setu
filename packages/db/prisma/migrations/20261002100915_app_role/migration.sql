-- Known gap 1 (HANDOVER): the API must connect as a role that RLS applies to — not the table owner, not a superuser.
-- The role is created without a password; `pnpm db:migrate` sets it from DATABASE_URL_APP (scripts/app-role-password.ts),
-- so no password ever lives in a migration. Production sets it from the secrets vault.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'setu_app') THEN
    CREATE ROLE setu_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO setu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO setu_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO setu_app;
-- Tables and sequences created by later migrations (run as the owner) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO setu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO setu_app;

-- Rule 5: the audit log is append-only for the API (the trigger also blocks it for everyone else).
REVOKE UPDATE, DELETE ON "AuditEvent" FROM setu_app;
-- Prisma's bookkeeping is not the API's business.
-- (Conditional: Prisma's shadow database replays migrations without this table.)
DO $$ BEGIN IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN REVOKE ALL ON "_prisma_migrations" FROM setu_app; END IF; END $$;

-- Tenant has no tenantId column, so the init loop skipped it: a session may only see its own tenant row.
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Tenant";
CREATE POLICY tenant_isolation ON "Tenant" USING ("id" = current_setting('app.tenant_id', true)) WITH CHECK ("id" = current_setting('app.tenant_id', true));
REVOKE INSERT, UPDATE, DELETE ON "Tenant" FROM setu_app;

-- Login happens before the tenant is known, so RLS hides every User row from setu_app. This one function is the
-- only pre-tenant read: it returns the active users matching a phone (either stored form) or email, with what the
-- password check and the session need, and nothing else. It runs as its owner (the migration role), which must be
-- a superuser or have BYPASSRLS — see docs/open-questions.md.
CREATE OR REPLACE FUNCTION auth_login_lookup(p_phones text[], p_email text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', u."id", 'tenantId', u."tenantId", 'nameBn', u."nameBn", 'nameEn', u."nameEn",
    'phone', u."phone", 'email', u."email", 'passwordHash', u."passwordHash", 'plan', t."plan",
    'roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('organizationId', r."organizationId", 'organizationName', o."name", 'role', r."role") ORDER BY r."id"), '[]'::jsonb)
              FROM "PractitionerRole" r JOIN "Organization" o ON o."id" = r."organizationId" WHERE r."userId" = u."id")
  )), '[]'::jsonb)
  FROM "User" u JOIN "Tenant" t ON t."id" = u."tenantId"
  WHERE u."active" AND (u."phone" = ANY (p_phones) OR (p_email IS NOT NULL AND u."email" = p_email));
$$;
REVOKE ALL ON FUNCTION auth_login_lookup(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login_lookup(text[], text) TO setu_app;
