-- Slice A12–A13 session 2: fixes from the clinical-safety and security reviews (verify lookups only; no table change).
-- • clinical H1: the prescription page carries each medicine's instruction (note), as the print does;
-- • clinical L2: whether a medicine came from the sample list (the page then says "sample list — not for real use");
-- • clinical L1: a lab value withdrawn (entered-in-error with no replacement) is told apart from one under correction;
-- • security L3/rule 5: both lookups return tenantId / patientId / documentId so the API can audit the public view —
--   the API strips them before answering.

CREATE OR REPLACE FUNCTION rx_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenantId', c."tenantId", 'patientId', c."patientId", 'documentId', c."id",
    'facilityEn', o."name", 'facilityBn', o."nameBn",
    'doctorEn', u."nameEn", 'doctorBn', u."nameBn", 'regBody', pr."regBody", 'regNo', pr."regNo", 'regVerified', COALESCE(pr."regVerified", false),
    'signedAt', c."signedAt", 'version', c."version", 'status', c."status",
    'initials', person_initials(p."nameEn", p."nameBn"), 'sex', p."sex",
    'birthDate', to_char(p."birthDate", 'YYYY-MM-DD'), 'approxAgeYears', p."approxAgeYears", 'approxAgeAt', p."approxAgeAt",
    'medicines', COALESCE((SELECT jsonb_agg(jsonb_build_object('brand', m."brand", 'generic', m."generic", 'strength', m."strength", 'form', m."form",
                                  'dose', m."dose", 'meal', m."meal", 'days', m."days", 'quantity', m."quantity", 'note', m."note", 'sample', m."sample") ORDER BY m."position")
                           FROM "MedicationRequest" m WHERE m."compositionId" = c."id" AND m."tenantId" = c."tenantId"), '[]'::jsonb))
  FROM "DocumentCode" d
  JOIN "Composition" c ON c."id" = d."documentId" AND c."tenantId" = d."tenantId"
  JOIN "Organization" o ON o."id" = c."organizationId"
  JOIN "Patient" p ON p."id" = c."patientId"
  LEFT JOIN "User" u ON u."id" = c."signedById"
  LEFT JOIN "Practitioner" pr ON pr."userId" = c."signedById"
  WHERE d."verifyCode" = p_code AND d."kind" = 'rx'
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION rx_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rx_verify_lookup(text) TO setu_app;

CREATE OR REPLACE FUNCTION lr_verify_lookup(p_code text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenantId', r."tenantId", 'patientId', r."patientId", 'documentId', r."id",
    'facilityEn', o."name", 'facilityBn', o."nameBn",
    'number', r."number", 'version', r."version", 'status', r."status", 'superseded', r."supersededById" IS NOT NULL,
    'releasedAt', r."releasedAt", 'testCount', r."testCount", 'pendingCount', r."pendingCount",
    'initials', person_initials(p."nameEn", p."nameBn"), 'sex', p."sex",
    'birthDate', to_char(p."birthDate", 'YYYY-MM-DD'), 'approxAgeYears', p."approxAgeYears", 'approxAgeAt', p."approxAgeAt",
    'results', COALESCE((SELECT jsonb_agg(jsonb_build_object('test', s."nameEn", 'code', ob."code", 'nameEn', a."nameEn", 'nameBn', a."nameBn",
                                'value', ob."value", 'unit', ob."unit", 'decimals', a."decimals", 'flag', ob."interpretation",
                                'refLow', ob."refLow", 'refHigh', ob."refHigh", 'refLabel', ob."refLabel",
                                'underCorrection', ob."status" = 'entered-in-error' AND EXISTS (SELECT 1 FROM "Observation" n WHERE n."replacesId" = ob."id" AND n."tenantId" = ob."tenantId"),
                                'withdrawn', ob."status" = 'entered-in-error' AND NOT EXISTS (SELECT 1 FROM "Observation" n WHERE n."replacesId" = ob."id" AND n."tenantId" = ob."tenantId"))
                                ORDER BY s."nameEn", a."code")
                         FROM "DiagnosticReportResult" x
                         JOIN "Observation" ob ON ob."id" = x."observationId" AND ob."tenantId" = x."tenantId"
                         JOIN "ServiceRequest" s ON s."id" = x."serviceRequestId" AND s."tenantId" = x."tenantId"
                         LEFT JOIN "LabAnalyte" a ON a."tenantId" = x."tenantId" AND a."code" = ob."code"
                         WHERE x."reportId" = r."id"), '[]'::jsonb))
  FROM "DocumentCode" d
  JOIN "DiagnosticReport" r ON r."id" = d."documentId" AND r."tenantId" = d."tenantId"
  JOIN "Organization" o ON o."id" = r."organizationId"
  JOIN "Patient" p ON p."id" = r."patientId"
  WHERE d."verifyCode" = p_code AND d."kind" = 'lr'
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION lr_verify_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lr_verify_lookup(text) TO setu_app;
