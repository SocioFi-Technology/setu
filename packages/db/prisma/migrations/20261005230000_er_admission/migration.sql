-- ADR 0014: ER visits, bed assignments, admissions, IPD bill kind; tokens unique per class.

-- CreateEnum
CREATE TYPE "BedAssignmentStatus" AS ENUM ('reserved', 'occupied', 'ended');

-- AlterEnum
ALTER TYPE "InvoiceKind" ADD VALUE 'ipd';

-- DropIndex
DROP INDEX "Encounter_tenantId_branchId_tokenDay_tokenNo_key";

-- DropIndex

-- DropIndex

-- CreateTable
CREATE TABLE "ErVisit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "arrivalMode" TEXT NOT NULL,
    "broughtBy" TEXT,
    "complaint" TEXT NOT NULL,
    "features" TEXT,
    "triageLevel" INTEGER,
    "triageTargetMinutes" INTEGER,
    "triagedAt" TIMESTAMP(3),
    "triagedById" TEXT,
    "dispositionKind" TEXT,
    "dispositionDetail" JSONB,
    "dispositionSignedAt" TIMESTAMP(3),
    "dispositionSignedById" TEXT,
    "compositionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BedAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "bedId" TEXT NOT NULL,
    "status" "BedAssignmentStatus" NOT NULL,
    "transferId" TEXT NOT NULL,
    "reservedAt" TIMESTAMP(3),
    "reservedById" TEXT,
    "occupiedAt" TIMESTAMP(3),
    "occupiedById" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BedAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "sourceEncounterId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "number" TEXT,
    "admittingDoctorId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "bedClass" TEXT NOT NULL,
    "bedId" TEXT NOT NULL,
    "guardianName" TEXT,
    "guardianRelationship" TEXT,
    "guardianPhone" TEXT,
    "consents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invoiceId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "admittedById" TEXT,
    "admittedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "Admission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErVisit_encounterId_key" ON "ErVisit"("encounterId");

-- CreateIndex
CREATE INDEX "ErVisit_tenantId_organizationId_branchId_idx" ON "ErVisit"("tenantId", "organizationId", "branchId");

-- CreateIndex
CREATE INDEX "ErVisit_tenantId_patientId_idx" ON "ErVisit"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "BedAssignment_tenantId_bedId_idx" ON "BedAssignment"("tenantId", "bedId");

-- CreateIndex
CREATE INDEX "BedAssignment_tenantId_patientId_idx" ON "BedAssignment"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "BedAssignment_tenantId_encounterId_idx" ON "BedAssignment"("tenantId", "encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "Admission_encounterId_key" ON "Admission"("encounterId");

-- CreateIndex
CREATE INDEX "Admission_tenantId_patientId_idx" ON "Admission"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "Admission_tenantId_organizationId_status_idx" ON "Admission"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Admission_tenantId_organizationId_number_key" ON "Admission"("tenantId", "organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_tenantId_branchId_tokenDay_class_tokenNo_key" ON "Encounter"("tenantId", "branchId", "tokenDay", "class", "tokenNo");

-- AddForeignKey
ALTER TABLE "ErVisit" ADD CONSTRAINT "ErVisit_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedAssignment" ADD CONSTRAINT "BedAssignment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedAssignment" ADD CONSTRAINT "BedAssignment_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Admission" ADD CONSTRAINT "Admission_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- row-level security on the new tables (same policy as every table with a tenantId)
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
