-- Row-level security keyed by the session variable app.tenant_id (set by @setu/db forTenant()).
-- Apply to every table that has tenantId. The API's DB role must NOT be the table owner or superuser.
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

-- Rule 5: the audit log is append-only.
CREATE OR REPLACE FUNCTION audit_no_change() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'AuditEvent is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_append_only ON "AuditEvent";
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION audit_no_change();
