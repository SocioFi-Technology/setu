-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('planned', 'arrived', 'triaged', 'in-progress', 'finished', 'cancelled', 'entered-in-error');

-- CreateEnum
CREATE TYPE "EncounterClass" AS ENUM ('opd', 'ipd', 'er', 'home');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('requested', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ProvenanceSource" AS ENUM ('provider-verified', 'patient-uploaded', 'patient-reported', 'ai-draft');

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "approxAgeAt" TIMESTAMP(3),
ADD COLUMN     "approxAgeMonths" INTEGER;

-- CreateTable
CREATE TABLE "Encounter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "class" "EncounterClass" NOT NULL DEFAULT 'opd',
    "status" "EncounterStatus" NOT NULL,
    "visitType" TEXT NOT NULL DEFAULT 'new',
    "practitionerId" TEXT,
    "token" TEXT NOT NULL,
    "tokenNo" INTEGER NOT NULL,
    "tokenDay" TEXT NOT NULL,
    "arrivedAt" TIMESTAMP(3),
    "calledAt" TIMESTAMP(3),
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL,
    "focusId" TEXT,
    "candidateId" TEXT,
    "reason" TEXT,
    "detail" JSONB,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provenance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "onBehalfOf" TEXT NOT NULL,
    "recorded" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ProvenanceSource" NOT NULL,
    "reason" TEXT,
    "detail" JSONB,

    CONSTRAINT "Provenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Encounter_tenantId_branchId_tokenDay_idx" ON "Encounter"("tenantId", "branchId", "tokenDay");

-- CreateIndex
CREATE INDEX "Encounter_tenantId_patientId_idx" ON "Encounter"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_tenantId_branchId_tokenDay_tokenNo_key" ON "Encounter"("tenantId", "branchId", "tokenDay", "tokenNo");

-- CreateIndex
CREATE INDEX "Task_tenantId_kind_status_idx" ON "Task"("tenantId", "kind", "status");

-- CreateIndex
CREATE INDEX "Task_tenantId_focusId_idx" ON "Task"("tenantId", "focusId");

-- CreateIndex
CREATE INDEX "Provenance_tenantId_targetType_targetId_idx" ON "Provenance"("tenantId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security for the new tables (same loop as rls.sql; idempotent for the existing ones).
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

-- Rule 2: provenance is a record of what happened; like the audit log it is append-only.
REVOKE UPDATE, DELETE ON "Provenance" FROM setu_app;
DROP TRIGGER IF EXISTS provenance_append_only ON "Provenance";
CREATE OR REPLACE FUNCTION provenance_no_change() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Provenance is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER provenance_append_only BEFORE UPDATE OR DELETE ON "Provenance" FOR EACH ROW EXECUTE FUNCTION provenance_no_change();

ALTER TABLE "Encounter" ADD CONSTRAINT encounter_token_no_positive CHECK ("tokenNo" > 0);
-- A link-anyway decision is only valid with a reason (domain rule: ≥10 characters, checked in @setu/domain too).
ALTER TABLE "Task" ADD CONSTRAINT task_link_reason CHECK ("kind" <> 'patient-link-review' OR "reason" IS NULL OR length(btrim("reason")) >= 10);
