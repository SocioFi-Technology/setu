-- Admin review (ADR 0010): a one-time password works for one sign-in — the login lookup returns when it was used.
CREATE OR REPLACE FUNCTION auth_login_lookup(p_phones text[], p_email text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', u."id", 'tenantId', u."tenantId", 'nameBn', u."nameBn", 'nameEn', u."nameEn",
    'phone', u."phone", 'email', u."email", 'passwordHash', u."passwordHash", 'plan', t."plan",
    'mustChangePassword', u."mustChangePassword", 'tempPasswordExpiresAt', u."tempPasswordExpiresAt", 'tempPasswordUsedAt', u."tempPasswordUsedAt", 'sessionGeneration', u."sessionGeneration",
    'roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('organizationId', r."organizationId", 'organizationName', o."name", 'role', r."role") ORDER BY r."id"), '[]'::jsonb)
              FROM "PractitionerRole" r JOIN "Organization" o ON o."id" = r."organizationId" WHERE r."userId" = u."id")
  )), '[]'::jsonb)
  FROM "User" u JOIN "Tenant" t ON t."id" = u."tenantId"
  WHERE u."active" AND (u."phone" = ANY (p_phones) OR (p_email IS NOT NULL AND u."email" = p_email));
$$;
REVOKE ALL ON FUNCTION auth_login_lookup(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login_lookup(text[], text) TO setu_app;
