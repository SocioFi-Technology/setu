-- CreateEnum
CREATE TYPE "ChargeKind" AS ENUM ('consultation', 'test', 'service');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'partially-paid', 'balanced', 'cancelled');

-- CreateEnum
CREATE TYPE "ChargeSource" AS ENUM ('consultation', 'order', 'desk');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('initiated', 'link-sent', 'waiting-customer', 'confirmed', 'failed');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'card', 'bank', 'bkash', 'nagad');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "approverLimitPaisa" INTEGER NOT NULL DEFAULT 1000000,
ADD COLUMN     "cashierDiscountLimitBp" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "cashierDiscountLimitPaisa" INTEGER NOT NULL DEFAULT 50000,
ADD COLUMN     "vatBin" TEXT,
ADD COLUMN     "vatBinSample" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ChargeItemDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "ChargeKind" NOT NULL,
    "refCode" TEXT,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "unitPaisa" INTEGER NOT NULL,
    "vatRateBp" INTEGER NOT NULL DEFAULT 0,
    "sample" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargeItemDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "number" TEXT,
    "subtotalPaisa" INTEGER NOT NULL DEFAULT 0,
    "discountPaisa" INTEGER NOT NULL DEFAULT 0,
    "netPaisa" INTEGER NOT NULL DEFAULT 0,
    "vatPaisa" INTEGER NOT NULL DEFAULT 0,
    "totalPaisa" INTEGER NOT NULL DEFAULT 0,
    "paidPaisa" INTEGER NOT NULL DEFAULT 0,
    "discountCategory" TEXT,
    "discountReason" TEXT,
    "discountAppliedById" TEXT,
    "discountAppliedAt" TIMESTAMP(3),
    "discountTaskId" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "source" "ChargeSource" NOT NULL,
    "sourceId" TEXT,
    "definitionId" TEXT,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "unitPaisa" INTEGER,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "vatRateBp" INTEGER NOT NULL DEFAULT 0,
    "grossPaisa" INTEGER NOT NULL DEFAULT 0,
    "discountPaisa" INTEGER NOT NULL DEFAULT 0,
    "netPaisa" INTEGER NOT NULL DEFAULT 0,
    "vatPaisa" INTEGER NOT NULL DEFAULT 0,
    "totalPaisa" INTEGER NOT NULL DEFAULT 0,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "amountPaisa" INTEGER NOT NULL,
    "tenderedPaisa" INTEGER,
    "changePaisa" INTEGER,
    "reference" TEXT,
    "provider" TEXT,
    "providerRef" TEXT,
    "supersededRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkUrl" TEXT,
    "linkExpiresAt" TIMESTAMP(3),
    "phone" TEXT,
    "trxId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "failReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "paymentId" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "trxId" TEXT,
    "amountPaisa" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChargeItemDefinition_tenantId_organizationId_code_key" ON "ChargeItemDefinition"("tenantId", "organizationId", "code");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_encounterId_idx" ON "Invoice"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_status_idx" ON "Invoice"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_organizationId_number_key" ON "Invoice"("tenantId", "organizationId", "number");

-- CreateIndex
CREATE INDEX "ChargeItem_tenantId_invoiceId_idx" ON "ChargeItem"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChargeItem_invoiceId_position_key" ON "ChargeItem"("invoiceId", "position");

-- CreateIndex
CREATE INDEX "Payment_tenantId_invoiceId_idx" ON "Payment"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerRef_key" ON "Payment"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "ProviderEvent_tenantId_paymentId_idx" ON "ProviderEvent"("tenantId", "paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEvent_provider_eventId_key" ON "ProviderEvent"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "ChargeItem" ADD CONSTRAINT "ChargeItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
