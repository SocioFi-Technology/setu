-- Pharmacy session 1 (ADR 0009): bill kinds (opd / pharmacy / otc; an otc bill has no visit and may have no patient),
-- medicine lines, the stock batches and ledger, dispenses. Tables from `prisma migrate diff`; the enum values are
-- committed here, the guards that use them are in the next migration (pharmacy_guards).

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('opd', 'pharmacy', 'otc');

-- AlterEnum
ALTER TYPE "ChargeKind" ADD VALUE 'medicine';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ChargeSource" ADD VALUE 'dispense';
ALTER TYPE "ChargeSource" ADD VALUE 'sale';

-- AlterTable
ALTER TABLE "ChargeItem" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "medicineKey" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "buyerName" TEXT,
ADD COLUMN     "buyerPhone" TEXT,
ADD COLUMN     "kind" "InvoiceKind" NOT NULL DEFAULT 'opd',
ADD COLUMN     "rxPhotoKey" TEXT,
ALTER COLUMN "patientId" DROP NOT NULL,
ALTER COLUMN "encounterId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Receipt" ALTER COLUMN "patientId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "StockBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "expiry" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT 'counter',
    "costPaisa" INTEGER NOT NULL,
    "mrpPaisa" INTEGER NOT NULL,
    "vatRateBp" INTEGER NOT NULL DEFAULT 0,
    "qtyOnHand" INTEGER NOT NULL DEFAULT 0,
    "sample" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMove" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "reason" TEXT,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationDispense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "compositionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "prescribedKey" TEXT NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "reason" TEXT,
    "invoiceId" TEXT,
    "chargeItemId" TEXT,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationDispense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockBatch_tenantId_organizationId_medicineKey_idx" ON "StockBatch"("tenantId", "organizationId", "medicineKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockBatch_tenantId_organizationId_medicineKey_batchNo_loca_key" ON "StockBatch"("tenantId", "organizationId", "medicineKey", "batchNo", "location");

-- CreateIndex
CREATE INDEX "StockMove_tenantId_batchId_idx" ON "StockMove"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "StockMove_tenantId_organizationId_at_idx" ON "StockMove"("tenantId", "organizationId", "at");

-- CreateIndex
CREATE INDEX "MedicationDispense_tenantId_encounterId_idx" ON "MedicationDispense"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "MedicationDispense_tenantId_requestId_idx" ON "MedicationDispense"("tenantId", "requestId");

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


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
