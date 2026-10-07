-- External review B8: the public receipt and refund-voucher checks are audited against the patient, like the
-- prescription / report checks. The lookups also return who to audit against (kept on the server, never answered).
CREATE OR REPLACE FUNCTION receipt_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('facilityEn', o."name", 'facilityBn', o."nameBn", 'number', r."number", 'createdAt', r."createdAt", 'paidPaisa', r."paidPaisa",
    'tenantId', r."tenantId", 'organizationId', r."organizationId", 'patientId', r."patientId", 'documentId', r."id")
  FROM "Receipt" r JOIN "Organization" o ON o."id" = r."organizationId"
  WHERE r."verifyCode" = p_code
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION receipt_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION receipt_verify_lookup(text) TO setu_app;

CREATE OR REPLACE FUNCTION refund_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('facilityEn', o."name", 'facilityBn', o."nameBn", 'number', v."number", 'createdAt', v."createdAt", 'amountPaisa', v."amountPaisa",
    'tenantId', v."tenantId", 'organizationId', v."organizationId", 'patientId', v."patientId", 'documentId', v."id")
  FROM "RefundVoucher" v JOIN "Organization" o ON o."id" = v."organizationId"
  WHERE v."verifyCode" = p_code
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION refund_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refund_verify_lookup(text) TO setu_app;
