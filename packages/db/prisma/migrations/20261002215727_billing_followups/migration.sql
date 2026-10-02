-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'entered-in-error';

-- AlterTable
ALTER TABLE "ChargeItem" ADD COLUMN     "notBilledAt" TIMESTAMP(3),
ADD COLUMN     "notBilledReason" TEXT,
ADD COLUMN     "notBilledTaskId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "replacedById" TEXT,
ADD COLUMN     "replacesId" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT;
