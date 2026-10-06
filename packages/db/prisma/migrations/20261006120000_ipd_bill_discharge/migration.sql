-- ADR 0017 (slice B7–B9): the IPD running bill (line keys, tags, supersession and credit lines), deposit receipts,
-- bed-class rates, packages, the discharge and its steps. The guards are in the next migration (the enum values must be
-- committed first).
ALTER TYPE "ChargeSource" ADD VALUE 'package';
ALTER TYPE "ChargeSource" ADD VALUE 'bed-day';
ALTER TYPE "ChargeSource" ADD VALUE 'stock';

-- AlterTable
ALTER TABLE "Admission" ADD COLUMN     "dischargedAt" TIMESTAMP(3),
ADD COLUMN     "dischargedById" TEXT,
ADD COLUMN     "packageAppliedAt" TIMESTAMP(3),
ADD COLUMN     "packageAppliedById" TEXT,
ADD COLUMN     "packageId" TEXT,
ADD COLUMN     "packageSnapshot" JSONB;

-- AlterTable
ALTER TABLE "ChargeItem" ADD COLUMN     "auto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bedClass" TEXT,
ADD COLUMN     "creditOfId" TEXT,
ADD COLUMN     "creditedById" TEXT,
ADD COLUMN     "dayNo" INTEGER,
ADD COLUMN     "key" TEXT,
ADD COLUMN     "serviceDay" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededById" TEXT,
ADD COLUMN     "supersededReason" TEXT,
ADD COLUMN     "tag" TEXT,
ALTER COLUMN "addedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'bill',
ADD COLUMN     "paymentId" TEXT;

-- CreateTable
CREATE TABLE "BedClassRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bedClass" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "perDayPaisa" INTEGER NOT NULL,
    "sample" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BedClassRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "validFrom" TEXT NOT NULL,
    "validTo" TEXT,
    "sample" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackagePrice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "bedClass" TEXT NOT NULL,
    "pricePaisa" INTEGER NOT NULL,

    CONSTRAINT "PackagePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT,
    "limitQty" INTEGER,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "PackageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discharge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "advice" TEXT NOT NULL,
    "targetAt" TIMESTAMP(3) NOT NULL,
    "orderedById" TEXT NOT NULL,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Discharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DischargeStep" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dischargeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "takenById" TEXT,
    "takenAt" TIMESTAMP(3),
    "doneById" TEXT,
    "doneAt" TIMESTAMP(3),
    "byHand" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "detail" JSONB,
    "remindedById" TEXT,
    "remindedAt" TIMESTAMP(3),
    "reminders" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DischargeStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BedClassRate_tenantId_organizationId_bedClass_key" ON "BedClassRate"("tenantId", "organizationId", "bedClass");

-- CreateIndex
CREATE UNIQUE INDEX "Package_tenantId_organizationId_code_key" ON "Package"("tenantId", "organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PackagePrice_packageId_bedClass_key" ON "PackagePrice"("packageId", "bedClass");

-- CreateIndex
CREATE INDEX "PackageItem_packageId_idx" ON "PackageItem"("packageId");

-- CreateIndex
CREATE INDEX "Discharge_tenantId_organizationId_status_idx" ON "Discharge"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE INDEX "Discharge_tenantId_admissionId_idx" ON "Discharge"("tenantId", "admissionId");

-- CreateIndex
CREATE UNIQUE INDEX "DischargeStep_dischargeId_key_key" ON "DischargeStep"("dischargeId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_paymentId_key" ON "Receipt"("paymentId");

-- AddForeignKey
ALTER TABLE "PackagePrice" ADD CONSTRAINT "PackagePrice_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DischargeStep" ADD CONSTRAINT "DischargeStep_dischargeId_fkey" FOREIGN KEY ("dischargeId") REFERENCES "Discharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

