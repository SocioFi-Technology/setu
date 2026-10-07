-- ADR 0018 (slice B10–B12): the IPD final bill's excess, the summary made available in the patient app, discharge kinds
-- and their record, the inpatient visit's outcome. The guards are in the next migration.
ALTER TABLE "Invoice" ADD COLUMN "excessPaisa" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Communication" ADD COLUMN "compositionId" TEXT;
ALTER TABLE "Discharge" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'normal', ADD COLUMN "detail" JSONB;
ALTER TABLE "Encounter" ADD COLUMN "outcome" TEXT;
