-- ADR 0016 (slice B5–B6): scans on the MAR, intake/output, care plan tasks, the shift handover.
-- CreateEnum
CREATE TYPE "CareTaskStatus" AS ENUM ('requested', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "HandoverStatus" AS ENUM ('draft', 'outgoing-signed', 'accepted');

-- AlterTable
ALTER TABLE "MedicationAdministration" ADD COLUMN     "scanBandAt" TIMESTAMP(3),
ADD COLUMN     "scanMedBatchId" TEXT,
ADD COLUMN     "scanOverrideReason" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "ioDayStartHour" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "shiftStartHours" INTEGER[] DEFAULT ARRAY[8, 14, 20]::INTEGER[];

-- CreateTable
CREATE TABLE "IntakeOutputEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "ml" INTEGER NOT NULL,
    "note" TEXT,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "writtenById" TEXT NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "NursingNoteStatus" NOT NULL DEFAULT 'active',
    "errorReason" TEXT,
    "errorById" TEXT,
    "errorAt" TIMESTAMP(3),

    CONSTRAINT "IntakeOutputEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "previousId" TEXT,
    "text" TEXT NOT NULL,
    "everyHours" INTEGER,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "CareTaskStatus" NOT NULL DEFAULT 'requested',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "CareTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handover" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "shiftDay" TEXT NOT NULL,
    "shiftStartHour" INTEGER NOT NULL,
    "status" "HandoverStatus" NOT NULL DEFAULT 'draft',
    "rev" INTEGER NOT NULL DEFAULT 1,
    "outgoingId" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3),
    "incomingId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptNote" TEXT,
    "queryNote" TEXT,
    "queriedById" TEXT,
    "queriedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Handover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoverPatient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "bed" TEXT NOT NULL,
    "situation" TEXT NOT NULL DEFAULT '',
    "background" TEXT NOT NULL DEFAULT '',
    "assessment" TEXT NOT NULL DEFAULT '',
    "recommendation" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "HandoverPatient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntakeOutputEntry_tenantId_encounterId_effectiveAt_idx" ON "IntakeOutputEntry"("tenantId", "encounterId", "effectiveAt");

-- CreateIndex
CREATE INDEX "CareTask_tenantId_encounterId_status_idx" ON "CareTask"("tenantId", "encounterId", "status");

-- CreateIndex
CREATE INDEX "Handover_tenantId_wardId_idx" ON "Handover"("tenantId", "wardId");

-- CreateIndex
CREATE UNIQUE INDEX "Handover_organizationId_wardId_shiftDay_shiftStartHour_key" ON "Handover"("organizationId", "wardId", "shiftDay", "shiftStartHour");

-- CreateIndex
CREATE UNIQUE INDEX "HandoverPatient_handoverId_encounterId_key" ON "HandoverPatient"("handoverId", "encounterId");

-- AddForeignKey
ALTER TABLE "HandoverPatient" ADD CONSTRAINT "HandoverPatient_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

