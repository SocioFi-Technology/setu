-- Gap 10 (pre-pilot security pass, open questions 20 / 24): defence in depth beside row-level security — a reference
-- never crosses tenants, checked by the database itself.
-- 1. Single-target references: composite (tenantId, id) foreign keys. Added NOT VALID, then validated, so a row that
--    already crosses tenants fails this migration loudly instead of passing unseen.
CREATE UNIQUE INDEX "Patient_tenantId_id_key" ON "Patient" ("tenantId", "id");
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_tenant_patient_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient" ("tenantId", "id") NOT VALID;
ALTER TABLE "Encounter" VALIDATE CONSTRAINT "Encounter_tenant_patient_fkey";
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_tenant_linkedTo_fkey" FOREIGN KEY ("tenantId", "linkedToId") REFERENCES "Patient" ("tenantId", "id") NOT VALID;
ALTER TABLE "Patient" VALIDATE CONSTRAINT "Patient_tenant_linkedTo_fkey";

-- 2. References whose table depends on the row (Task.focusId / candidateId by the task's kind; Provenance.targetId by
--    targetType): a trigger finds the target and refuses one of another tenant, or none. Under setu_app the row-level
--    security hides other tenants' rows, so a foreign target is simply not found — refused the same way.
CREATE OR REPLACE FUNCTION tenant_target_ok(p_table text, p_id text, p_tenant text, p_col text DEFAULT 'id') RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE t text;
BEGIN
  EXECUTE format('SELECT "tenantId" FROM %I WHERE %I = $1 LIMIT 1', p_table, p_col) INTO t USING p_id;
  RETURN t IS NOT NULL AND t = p_tenant;
END $$;

CREATE OR REPLACE FUNCTION task_tenant_guard() RETURNS trigger AS $$
DECLARE focus_t text; cand_t text;
BEGIN
  SELECT CASE NEW."kind"
           WHEN 'patient-link-review' THEN 'Patient' WHEN 'discount-approval' THEN 'Invoice' WHEN 'bill-elsewhere' THEN 'Invoice'
           WHEN 'payment-reconciliation' THEN 'Payment' WHEN 'purchase-approval' THEN 'PurchaseOrder' WHEN 'refund-approval' THEN 'Invoice'
           WHEN 'refund-reconciliation' THEN 'RefundAllocation' END,
         CASE NEW."kind" WHEN 'patient-link-review' THEN 'Patient' WHEN 'bill-elsewhere' THEN 'ChargeItem' END
    INTO focus_t, cand_t;
  IF NEW."focusId" IS NOT NULL AND focus_t IS NOT NULL AND NOT tenant_target_ok(focus_t, NEW."focusId", NEW."tenantId") THEN
    RAISE EXCEPTION 'Task: % focus % is not a % of this tenant', NEW."kind", NEW."focusId", focus_t;
  END IF;
  IF NEW."candidateId" IS NOT NULL AND cand_t IS NOT NULL AND NOT tenant_target_ok(cand_t, NEW."candidateId", NEW."tenantId") THEN
    RAISE EXCEPTION 'Task: % candidate % is not a % of this tenant', NEW."kind", NEW."candidateId", cand_t;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER task_tenant_guard BEFORE INSERT OR UPDATE OF "focusId", "candidateId", "tenantId" ON "Task" FOR EACH ROW EXECUTE FUNCTION task_tenant_guard();

CREATE OR REPLACE FUNCTION provenance_tenant_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."targetType" = 'Observation' THEN
    -- a vitals or lab batch (targetId = batchId) or one observation
    IF NOT (tenant_target_ok('Observation', NEW."targetId", NEW."tenantId", 'batchId') OR tenant_target_ok('Observation', NEW."targetId", NEW."tenantId")) THEN
      RAISE EXCEPTION 'Provenance: Observation % is not of this tenant', NEW."targetId";
    END IF;
  ELSIF NEW."targetType" IN ('Patient', 'Composition', 'AllergyIntolerance', 'ServiceRequest') THEN
    IF NOT tenant_target_ok(NEW."targetType", NEW."targetId", NEW."tenantId") THEN
      RAISE EXCEPTION 'Provenance: % % is not of this tenant', NEW."targetType", NEW."targetId";
    END IF;
  ELSE
    RAISE EXCEPTION 'Provenance: unknown target type %', NEW."targetType";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER provenance_tenant_guard BEFORE INSERT ON "Provenance" FOR EACH ROW EXECUTE FUNCTION provenance_tenant_guard();
