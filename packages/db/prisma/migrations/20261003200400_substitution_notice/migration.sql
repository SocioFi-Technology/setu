-- Pharmacy session 1 (ADR 0009): a doctor-inbox substitution notice points at the dispense it is about.
-- AlterTable
ALTER TABLE "Communication" ADD COLUMN     "dispenseId" TEXT;

