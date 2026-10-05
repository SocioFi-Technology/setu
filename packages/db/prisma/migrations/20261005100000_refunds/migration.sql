-- Refunds (ADR 0013): Refund, its credit-note lines and payout allocations, the voucher and its prints, resale decisions.
-- (The diff also proposed dropping Payment_supersededLinkCodes_idx — made by hand in sms_review, not in the schema; kept.)

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('requested', 'approved', 'paid', 'rejected', 'withdrawn');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "refundedPaisa" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MedicationDispense" ADD COLUMN     "refundLineId" TEXT,
ADD COLUMN     "returnOfId" TEXT;

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'bill',
    "caseTaskId" TEXT,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'requested',
    "amountPaisa" INTEGER NOT NULL,
    "netPaisa" INTEGER NOT NULL,
    "vatPaisa" INTEGER NOT NULL,
    "needsOwner" BOOLEAN NOT NULL DEFAULT false,
    "approvalTaskId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "withdrawnById" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawNote" TEXT,
    "recipientName" TEXT,
    "recipientPhone" TEXT,
    "recipientRelation" TEXT,
    "paidAt" TIMESTAMP(3),
    "rev" INTEGER NOT NULL DEFAULT 1,
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "chargeItemId" TEXT NOT NULL,
    "units" INTEGER,
    "netPaisa" INTEGER NOT NULL,
    "vatPaisa" INTEGER NOT NULL,
    "totalPaisa" INTEGER NOT NULL,

    CONSTRAINT "RefundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundAllocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountPaisa" INTEGER NOT NULL,
    "way" TEXT NOT NULL,
    "cashReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "gatewayFailedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "refundTrxId" TEXT,
    "reference" TEXT,
    "shiftId" TEXT,
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "needsReconciliation" BOOLEAN NOT NULL DEFAULT false,
    "reconcileTaskId" TEXT,

    CONSTRAINT "RefundAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundVoucher" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientId" TEXT,
    "number" TEXT NOT NULL,
    "verifyCode" TEXT NOT NULL,
    "amountPaisa" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundVoucherPrint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "copy" INTEGER NOT NULL,
    "reason" TEXT,
    "format" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "printedById" TEXT NOT NULL,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundVoucherPrint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockResale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromBatchId" TEXT NOT NULL,
    "toBatchId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unopened" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "transferRef" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockResale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Refund_tenantId_invoiceId_idx" ON "Refund"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "Refund_tenantId_organizationId_status_idx" ON "Refund"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE INDEX "RefundLine_tenantId_refundId_idx" ON "RefundLine"("tenantId", "refundId");

-- CreateIndex
CREATE INDEX "RefundLine_tenantId_chargeItemId_idx" ON "RefundLine"("tenantId", "chargeItemId");

-- CreateIndex
CREATE INDEX "RefundAllocation_tenantId_refundId_idx" ON "RefundAllocation"("tenantId", "refundId");

-- CreateIndex
CREATE INDEX "RefundAllocation_tenantId_paymentId_idx" ON "RefundAllocation"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "RefundAllocation_tenantId_shiftId_idx" ON "RefundAllocation"("tenantId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundVoucher_refundId_key" ON "RefundVoucher"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundVoucher_verifyCode_key" ON "RefundVoucher"("verifyCode");

-- CreateIndex
CREATE INDEX "RefundVoucher_tenantId_invoiceId_idx" ON "RefundVoucher"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundVoucher_tenantId_organizationId_number_key" ON "RefundVoucher"("tenantId", "organizationId", "number");

-- CreateIndex
CREATE INDEX "RefundVoucherPrint_tenantId_voucherId_idx" ON "RefundVoucherPrint"("tenantId", "voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundVoucherPrint_voucherId_copy_key" ON "RefundVoucherPrint"("voucherId", "copy");

-- CreateIndex
CREATE UNIQUE INDEX "StockResale_transferRef_key" ON "StockResale"("transferRef");

-- CreateIndex
CREATE INDEX "StockResale_tenantId_fromBatchId_idx" ON "StockResale"("tenantId", "fromBatchId");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundAllocation" ADD CONSTRAINT "RefundAllocation_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundVoucher" ADD CONSTRAINT "RefundVoucher_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundVoucherPrint" ADD CONSTRAINT "RefundVoucherPrint_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "RefundVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
