-- Gap 10 fix: the provenance check knew five target types; the code writes nine (the consultation signs Conditions and
-- MedicationRequests, the lab records Specimens and DiagnosticReports). Every type in use is checked; any other is
-- still refused.
CREATE OR REPLACE FUNCTION provenance_tenant_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."targetType" = 'Observation' THEN
    -- a vitals or lab batch (targetId = batchId) or one observation
    IF NOT (tenant_target_ok('Observation', NEW."targetId", NEW."tenantId", 'batchId') OR tenant_target_ok('Observation', NEW."targetId", NEW."tenantId")) THEN
      RAISE EXCEPTION 'Provenance: Observation % is not of this tenant', NEW."targetId";
    END IF;
  ELSIF NEW."targetType" IN ('Patient', 'Composition', 'AllergyIntolerance', 'ServiceRequest', 'Condition', 'MedicationRequest', 'Specimen', 'DiagnosticReport') THEN
    IF NOT tenant_target_ok(NEW."targetType", NEW."targetId", NEW."tenantId") THEN
      RAISE EXCEPTION 'Provenance: % % is not of this tenant', NEW."targetType", NEW."targetId";
    END IF;
  ELSE
    RAISE EXCEPTION 'Provenance: unknown target type %', NEW."targetType";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
