-- Slice A8–A11 (ADR 0006): lab tables and columns. Guards that use the new enum values are in the next migration
-- (lab_guards): a value added to an enum must be committed before a constraint or index uses it.

-- CreateEnum
CREATE TYPE "SpecimenStatus" AS ENUM ('pending', 'collected', 'received', 'in-process', 'done', 'rejected');

-- CreateEnum
CREATE TYPE "TubeKind" AS ENUM ('edta', 'fluoride', 'plain', 'urine');

-- CreateEnum
CREATE TYPE "LabReportStatus" AS ENUM ('preliminary', 'final', 'corrected', 'superseded');

-- CreateEnum
CREATE TYPE "CallbackOutcome" AS ENUM ('reached', 'no-answer');

-- CreateEnum
CREATE TYPE "CommunicationStatus" AS ENUM ('preparation', 'in-progress', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('sms', 'patient-app', 'doctor-inbox');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ObservationStatus" ADD VALUE 'preliminary';
ALTER TYPE "ObservationStatus" ADD VALUE 'verified';

-- AlterTable
ALTER TABLE "Observation" ADD COLUMN     "critHigh" DOUBLE PRECISION,
ADD COLUMN     "critLow" DOUBLE PRECISION,
ADD COLUMN     "deltaPct" INTEGER,
ADD COLUMN     "deltaPrevId" TEXT,
ADD COLUMN     "errorAt" TIMESTAMP(3),
ADD COLUMN     "errorById" TEXT,
ADD COLUMN     "errorReason" TEXT,
ADD COLUMN     "refHigh" DOUBLE PRECISION,
ADD COLUMN     "refLabel" TEXT,
ADD COLUMN     "refLow" DOUBLE PRECISION,
ADD COLUMN     "replacesId" TEXT,
ADD COLUMN     "serviceRequestId" TEXT,
ADD COLUMN     "specimenId" TEXT,
ADD COLUMN     "statusAt" TIMESTAMP(3),
ADD COLUMN     "validatedAt" TIMESTAMP(3),
ADD COLUMN     "validatedById" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "labSamePersonAllowed" BOOLEAN;

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "revokeReason" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedById" TEXT;

-- CreateTable
CREATE TABLE "Specimen" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "tube" "TubeKind" NOT NULL,
    "status" "SpecimenStatus" NOT NULL DEFAULT 'pending',
    "labelPrintedById" TEXT NOT NULL,
    "labelPrintedAt" TIMESTAMP(3) NOT NULL,
    "labelPrints" INTEGER NOT NULL DEFAULT 1,
    "collectedById" TEXT,
    "collectedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "rejectNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Specimen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecimenOrder" (
    "tenantId" TEXT NOT NULL,
    "specimenId" TEXT NOT NULL,
    "serviceRequestId" TEXT NOT NULL,

    CONSTRAINT "SpecimenOrder_pkey" PRIMARY KEY ("specimenId","serviceRequestId")
);

-- CreateTable
CREATE TABLE "LabAnalyte" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "testCode" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "critLow" DOUBLE PRECISION,
    "critHigh" DOUBLE PRECISION,
    "deltaCheck" BOOLEAN NOT NULL,
    "position" INTEGER NOT NULL,
    "sample" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LabAnalyte_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabReferenceRange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "analyteCode" TEXT NOT NULL,
    "sex" "Sex",
    "ageMinYears" INTEGER NOT NULL,
    "ageMaxYears" INTEGER,
    "low" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "label" TEXT NOT NULL,
    "sample" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LabReferenceRange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "LabReportStatus" NOT NULL,
    "testCount" INTEGER NOT NULL,
    "pendingCount" INTEGER NOT NULL,
    "replacesId" TEXT,
    "supersededById" TEXT,
    "releasedById" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiagnosticReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticReportResult" (
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "serviceRequestId" TEXT NOT NULL,

    CONSTRAINT "DiagnosticReportResult_pkey" PRIMARY KEY ("reportId","observationId")
);

-- CreateTable
CREATE TABLE "CriticalCallback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "outcome" "CallbackOutcome" NOT NULL,
    "recipientRole" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "calledAt" TIMESTAMP(3) NOT NULL,
    "readBack" BOOLEAN NOT NULL,
    "callerId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriticalCallback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Communication" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "kind" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "recipientUserId" TEXT,
    "toPhone" TEXT,
    "templateKey" TEXT,
    "text" TEXT,
    "reportId" TEXT,
    "specimenId" TEXT,
    "serviceRequestId" TEXT,
    "observationId" TEXT,
    "status" "CommunicationStatus" NOT NULL DEFAULT 'preparation',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "providerRef" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Communication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Specimen_tenantId_encounterId_idx" ON "Specimen"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "Specimen_tenantId_organizationId_status_idx" ON "Specimen"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Specimen_tenantId_number_key" ON "Specimen"("tenantId", "number");

-- CreateIndex
CREATE INDEX "SpecimenOrder_tenantId_serviceRequestId_idx" ON "SpecimenOrder"("tenantId", "serviceRequestId");

-- CreateIndex
CREATE INDEX "LabAnalyte_tenantId_testCode_idx" ON "LabAnalyte"("tenantId", "testCode");

-- CreateIndex
CREATE UNIQUE INDEX "LabAnalyte_tenantId_code_key" ON "LabAnalyte"("tenantId", "code");

-- CreateIndex
CREATE INDEX "LabReferenceRange_tenantId_analyteCode_idx" ON "LabReferenceRange"("tenantId", "analyteCode");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticReport_replacesId_key" ON "DiagnosticReport"("replacesId");

-- CreateIndex
CREATE INDEX "DiagnosticReport_tenantId_organizationId_releasedAt_idx" ON "DiagnosticReport"("tenantId", "organizationId", "releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticReport_tenantId_encounterId_version_key" ON "DiagnosticReport"("tenantId", "encounterId", "version");

-- CreateIndex
CREATE INDEX "DiagnosticReportResult_tenantId_observationId_idx" ON "DiagnosticReportResult"("tenantId", "observationId");

-- CreateIndex
CREATE INDEX "CriticalCallback_tenantId_observationId_idx" ON "CriticalCallback"("tenantId", "observationId");

-- CreateIndex
CREATE INDEX "Communication_tenantId_encounterId_idx" ON "Communication"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "Communication_tenantId_reportId_idx" ON "Communication"("tenantId", "reportId");

-- CreateIndex
CREATE INDEX "Communication_tenantId_recipientUserId_channel_idx" ON "Communication"("tenantId", "recipientUserId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Observation_replacesId_key" ON "Observation"("replacesId");

-- CreateIndex
CREATE INDEX "Observation_tenantId_serviceRequestId_idx" ON "Observation"("tenantId", "serviceRequestId");

-- AddForeignKey
ALTER TABLE "SpecimenOrder" ADD CONSTRAINT "SpecimenOrder_specimenId_fkey" FOREIGN KEY ("specimenId") REFERENCES "Specimen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticReportResult" ADD CONSTRAINT "DiagnosticReportResult_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "DiagnosticReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


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

-- The sample analyte list and reference ranges are seeded by the owner; the API only reads them (pending clinician
-- sign-off, decision D1; masters screens later).
REVOKE INSERT, UPDATE, DELETE ON "LabAnalyte", "LabReferenceRange" FROM setu_app;
