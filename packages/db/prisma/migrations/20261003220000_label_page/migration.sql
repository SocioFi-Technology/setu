-- Pharmacy session 3 (ADR 0009, Kamrul 03/10/2026): the dose label's page size, a facility setting (default 50 × 30 mm).
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "labelHeightMm" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "labelWidthMm" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "Organization" ADD CONSTRAINT organization_label_page CHECK ("labelWidthMm" BETWEEN 20 AND 150 AND "labelHeightMm" BETWEEN 15 AND 150);
