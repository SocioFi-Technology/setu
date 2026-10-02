-- CreateEnum
CREATE TYPE "ObservationStatus" AS ENUM ('final', 'amended', 'entered-in-error');

-- CreateEnum
CREATE TYPE "ObservationInterpretation" AS ENUM ('N', 'H', 'L', 'HH', 'LL');

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'vital-signs',
    "code" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "method" TEXT,
    "interpretation" "ObservationInterpretation",
    "status" "ObservationStatus" NOT NULL DEFAULT 'final',
    "recordedById" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceLabel" TEXT,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Observation_tenantId_patientId_code_effectiveAt_idx" ON "Observation"("tenantId", "patientId", "code", "effectiveAt");

-- CreateIndex
CREATE INDEX "Observation_tenantId_encounterId_idx" ON "Observation"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "Observation_tenantId_batchId_idx" ON "Observation"("tenantId", "batchId");

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security for the new table (same loop as rls.sql; idempotent for the existing ones).
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

-- Rule 3 (amend, never overwrite): an observation is never edited or deleted by the API; a correction is a new row.
REVOKE UPDATE, DELETE ON "Observation" FROM setu_app;
ALTER TABLE "Observation" ADD CONSTRAINT observation_value_finite CHECK ("value" = "value" AND "value" > -1e9 AND "value" < 1e9);
