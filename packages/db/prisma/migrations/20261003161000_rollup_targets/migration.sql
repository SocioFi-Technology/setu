-- Slice C1–C4 session 1 (ADR 0008): the nightly rollup job runs per tenant under RLS; this lists only which facilities
-- exist (tenant id + facility id, nothing else) so the job knows where to run.
CREATE OR REPLACE FUNCTION rollup_targets()
RETURNS TABLE (tenant_id text, organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o."tenantId", o."id" FROM "Organization" o ORDER BY o."tenantId", o."id";
$$;
REVOKE ALL ON FUNCTION rollup_targets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rollup_targets() TO setu_app;
