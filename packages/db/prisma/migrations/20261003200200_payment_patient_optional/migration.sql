-- Pharmacy session 1 (ADR 0009): a payment on an over-the-counter bill may have no patient (a walk-in buyer).
-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "patientId" DROP NOT NULL;

ALTER TABLE "Payment" ADD CONSTRAINT payment_patient_kind CHECK ("patientId" IS NOT NULL OR "invoiceId" IS NOT NULL);
