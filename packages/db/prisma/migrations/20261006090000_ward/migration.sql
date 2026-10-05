-- ADR 0015: the ward — inpatient orders, the MAR, multi-dose vials, NEWS2 escalations, nursing notes, indents, the controlled-drug register; Medicine ward flags; Composition threads.
-- CreateEnum
CREATE TYPE "MedicationOrderStatus" AS ENUM ('active', 'stopped', 'superseded', 'completed');

-- CreateEnum
CREATE TYPE "MarDoseStatus" AS ENUM ('given', 'held', 'refused', 'missed', 'entered-in-error');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('raised', 'doctor-informed', 'resolved');

-- CreateEnum
CREATE TYPE "NursingNoteStatus" AS ENUM ('active', 'entered-in-error');

-- CreateEnum
CREATE TYPE "IndentStatus" AS ENUM ('requested', 'partially-issued', 'issued', 'cancelled');

-- DropIndex
DROP INDEX "Composition_tenantId_encounterId_kind_version_key";

-- DropIndex

-- DropIndex

-- AlterTable
ALTER TABLE "Composition" ADD COLUMN     "threadId" TEXT;

-- AlterTable
ALTER TABLE "MedicationRequest" ADD COLUMN     "continuesId" TEXT,
ADD COLUMN     "doseQty" INTEGER,
ADD COLUMN     "doseText" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'opd',
ADD COLUMN     "orderStatus" "MedicationOrderStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "prn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "prnMaxPer24h" INTEGER,
ADD COLUMN     "regimenId" TEXT,
ADD COLUMN     "route" TEXT,
ADD COLUMN     "startAt" TIMESTAMP(3),
ADD COLUMN     "stopReason" TEXT,
ADD COLUMN     "stoppedAt" TIMESTAMP(3),
ADD COLUMN     "stoppedById" TEXT,
ADD COLUMN     "times" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Medicine" ADD COLUMN     "controlled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "highAlert" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inpatientOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "issueUnit" TEXT NOT NULL DEFAULT 'tablet',
ADD COLUMN     "multiDose" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "routes" TEXT[] DEFAULT ARRAY['oral']::TEXT[];

-- CreateTable
CREATE TABLE "MedicationAdministration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "regimenId" TEXT NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "status" "MarDoseStatus" NOT NULL,
    "administeredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "administeredById" TEXT NOT NULL,
    "preparedById" TEXT NOT NULL,
    "checkPatient" BOOLEAN NOT NULL DEFAULT false,
    "checkDrug" BOOLEAN NOT NULL DEFAULT false,
    "checkDose" BOOLEAN NOT NULL DEFAULT false,
    "checkRoute" BOOLEAN NOT NULL DEFAULT false,
    "checkTime" BOOLEAN NOT NULL DEFAULT false,
    "timing" TEXT NOT NULL,
    "reason" TEXT,
    "route" TEXT NOT NULL,
    "doseText" TEXT NOT NULL,
    "doseQty" INTEGER,
    "source" TEXT NOT NULL,
    "stockRef" TEXT,
    "highAlert" BOOLEAN NOT NULL DEFAULT false,
    "controlled" BOOLEAN NOT NULL DEFAULT false,
    "witnessedById" TEXT,
    "witnessedAt" TIMESTAMP(3),
    "errorReason" TEXT,
    "errorById" TEXT,
    "errorAt" TIMESTAMP(3),

    CONSTRAINT "MedicationAdministration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MultiDoseVial" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "regimenId" TEXT NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "stockRef" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "openedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MultiDoseVial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" "EscalationStatus" NOT NULL,
    "score" INTEGER NOT NULL,
    "peakScore" INTEGER NOT NULL,
    "red" BOOLEAN NOT NULL,
    "observationId" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL,
    "raisedById" TEXT NOT NULL,
    "informedAt" TIMESTAMP(3),
    "informedById" TEXT,
    "spokeTo" TEXT,
    "instruction" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolveNote" TEXT,

    CONSTRAINT "EscalationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NursingNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "writtenById" TEXT NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "status" "NursingNoteStatus" NOT NULL DEFAULT 'active',
    "errorReason" TEXT,
    "errorById" TEXT,
    "errorAt" TIMESTAMP(3),

    CONSTRAINT "NursingNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WardIndent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "IndentStatus" NOT NULL DEFAULT 'requested',
    "note" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "WardIndent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WardIndentLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "indentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "qtyRequested" INTEGER NOT NULL,
    "qtyIssued" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WardIndentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WardIndentIssue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "indentId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "fromBatchId" TEXT NOT NULL,
    "toBatchId" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WardIndentIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControlledDrugRegister" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "stockMoveId" TEXT,
    "batchId" TEXT,
    "qty" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "encounterId" TEXT,
    "patientId" TEXT,
    "administrationId" TEXT,
    "indentId" TEXT,
    "byId" TEXT NOT NULL,
    "witnessId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ControlledDrugRegister_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MedicationAdministration_tenantId_encounterId_idx" ON "MedicationAdministration"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "MedicationAdministration_tenantId_regimenId_idx" ON "MedicationAdministration"("tenantId", "regimenId");

-- CreateIndex
CREATE INDEX "MultiDoseVial_tenantId_encounterId_idx" ON "MultiDoseVial"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "EscalationEvent_tenantId_encounterId_idx" ON "EscalationEvent"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "NursingNote_tenantId_encounterId_idx" ON "NursingNote"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "WardIndent_tenantId_organizationId_status_idx" ON "WardIndent"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WardIndent_tenantId_organizationId_number_key" ON "WardIndent"("tenantId", "organizationId", "number");

-- CreateIndex
CREATE INDEX "WardIndentLine_tenantId_indentId_idx" ON "WardIndentLine"("tenantId", "indentId");

-- CreateIndex
CREATE INDEX "WardIndentIssue_tenantId_indentId_idx" ON "WardIndentIssue"("tenantId", "indentId");

-- CreateIndex
CREATE UNIQUE INDEX "ControlledDrugRegister_stockMoveId_key" ON "ControlledDrugRegister"("stockMoveId");

-- CreateIndex
CREATE INDEX "ControlledDrugRegister_tenantId_organizationId_medicineKey_idx" ON "ControlledDrugRegister"("tenantId", "organizationId", "medicineKey");

-- CreateIndex
CREATE INDEX "Composition_tenantId_encounterId_kind_idx" ON "Composition"("tenantId", "encounterId", "kind");

-- CreateIndex
CREATE INDEX "MedicationRequest_tenantId_encounterId_kind_idx" ON "MedicationRequest"("tenantId", "encounterId", "kind");

-- AddForeignKey
ALTER TABLE "WardIndentLine" ADD CONSTRAINT "WardIndentLine_indentId_fkey" FOREIGN KEY ("indentId") REFERENCES "WardIndent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- version uniqueness and the one-current rule: per (encounter, kind) for every kind but the ward round note, per thread for it
CREATE UNIQUE INDEX "Composition_version_per_kind" ON "Composition"("tenantId", "encounterId", "kind", "version") WHERE "kind" <> 'progress-note';
CREATE UNIQUE INDEX "Composition_version_per_thread" ON "Composition"("tenantId", "threadId", "version") WHERE "kind" = 'progress-note';
DROP INDEX "Composition_one_current";
CREATE UNIQUE INDEX "Composition_one_current" ON "Composition" ("tenantId", "encounterId", "kind") WHERE "status" IN ('final', 'amended') AND "kind" <> 'progress-note';
CREATE UNIQUE INDEX "Composition_one_current_thread" ON "Composition" ("tenantId", "threadId") WHERE "status" IN ('final', 'amended') AND "kind" = 'progress-note';
ALTER TABLE "Composition" ADD CONSTRAINT composition_thread CHECK (("kind" = 'progress-note') = ("threadId" IS NOT NULL));

-- row-level security on the new tables
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
