-- CreateEnum
CREATE TYPE "MealTiming" AS ENUM ('before', 'after', 'with', 'any');

-- CreateEnum
CREATE TYPE "AllergyStatus" AS ENUM ('active', 'entered-in-error');

-- CreateEnum
CREATE TYPE "AllergyKind" AS ENUM ('class', 'substance', 'other');

-- CreateEnum
CREATE TYPE "AllergySeverity" AS ENUM ('mild', 'moderate', 'severe', 'unknown');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('draft', 'queued', 'final', 'amended', 'superseded', 'entered-in-error');

-- CreateEnum
CREATE TYPE "ConditionVerification" AS ENUM ('provisional', 'confirmed');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'active', 'centre-chosen', 'accepted', 'partially-accepted', 'declined', 'in-progress', 'partially-complete', 'complete', 'revoked');

-- CreateEnum
CREATE TYPE "OrderPriority" AS ENUM ('routine', 'urgent', 'stat');

-- CreateTable
CREATE TABLE "Icd11Code" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "bn" TEXT NOT NULL,
    "en" TEXT NOT NULL,
    "aliases" TEXT NOT NULL DEFAULT '',
    "verification" TEXT NOT NULL DEFAULT 'unverified-prototype',

    CONSTRAINT "Icd11Code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Medicine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "brandBn" TEXT NOT NULL DEFAULT '',
    "generic" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "ingredients" TEXT[],
    "classes" TEXT[],
    "defaultDose" TEXT NOT NULL,
    "defaultMeal" "MealTiming" NOT NULL,
    "defaultDays" INTEGER NOT NULL,
    "sample" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Medicine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderableTest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "OrderableTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllergyIntolerance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "kind" "AllergyKind" NOT NULL,
    "key" TEXT,
    "labelBn" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "reaction" TEXT,
    "severity" "AllergySeverity" NOT NULL DEFAULT 'unknown',
    "status" "AllergyStatus" NOT NULL DEFAULT 'active',
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorReason" TEXT,
    "errorById" TEXT,
    "errorAt" TIMESTAMP(3),

    CONSTRAINT "AllergyIntolerance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Composition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'consultation-note',
    "version" INTEGER NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'draft',
    "amendsId" TEXT,
    "supersededById" TEXT,
    "amendReason" TEXT,
    "sections" JSONB NOT NULL,
    "sectionSources" JSONB NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "signedAt" TIMESTAMP(3),
    "signedById" TEXT,
    "aiReviewed" BOOLEAN NOT NULL DEFAULT false,
    "uncodedAllergiesChecked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Composition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Condition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "compositionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "codeSystem" TEXT NOT NULL DEFAULT 'icd11',
    "codeVerification" TEXT NOT NULL,
    "labelBn" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "verificationStatus" "ConditionVerification" NOT NULL DEFAULT 'provisional',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "compositionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "medicineKey" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "generic" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "ingredients" TEXT[],
    "classes" TEXT[],
    "sample" BOOLEAN NOT NULL DEFAULT true,
    "dose" TEXT NOT NULL,
    "meal" "MealTiming" NOT NULL,
    "days" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "keepBoth" BOOLEAN NOT NULL DEFAULT false,
    "acks" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "compositionId" TEXT NOT NULL,
    "testCode" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "priority" "OrderPriority" NOT NULL DEFAULT 'routine',
    "status" "OrderStatus" NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "orderedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderedAt" TIMESTAMP(3),
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Icd11Code_tenantId_code_key" ON "Icd11Code"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Medicine_tenantId_key_key" ON "Medicine"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "OrderableTest_tenantId_code_key" ON "OrderableTest"("tenantId", "code");

-- CreateIndex
CREATE INDEX "AllergyIntolerance_tenantId_patientId_status_idx" ON "AllergyIntolerance"("tenantId", "patientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Composition_amendsId_key" ON "Composition"("amendsId");

-- CreateIndex
CREATE INDEX "Composition_tenantId_patientId_status_idx" ON "Composition"("tenantId", "patientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Composition_tenantId_encounterId_kind_version_key" ON "Composition"("tenantId", "encounterId", "kind", "version");

-- CreateIndex
CREATE INDEX "Condition_tenantId_compositionId_idx" ON "Condition"("tenantId", "compositionId");

-- CreateIndex
CREATE INDEX "Condition_tenantId_patientId_idx" ON "Condition"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "MedicationRequest_tenantId_compositionId_idx" ON "MedicationRequest"("tenantId", "compositionId");

-- CreateIndex
CREATE INDEX "MedicationRequest_tenantId_patientId_idx" ON "MedicationRequest"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "ServiceRequest_tenantId_encounterId_idx" ON "ServiceRequest"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "ServiceRequest_tenantId_compositionId_idx" ON "ServiceRequest"("tenantId", "compositionId");

-- AddForeignKey
ALTER TABLE "AllergyIntolerance" ADD CONSTRAINT "AllergyIntolerance_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Composition" ADD CONSTRAINT "Composition_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Composition" ADD CONSTRAINT "Composition_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_compositionId_fkey" FOREIGN KEY ("compositionId") REFERENCES "Composition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationRequest" ADD CONSTRAINT "MedicationRequest_compositionId_fkey" FOREIGN KEY ("compositionId") REFERENCES "Composition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_compositionId_fkey" FOREIGN KEY ("compositionId") REFERENCES "Composition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- Catalogues are seeded by the owner; the API only reads them (masters screens come in phase 2).
REVOKE INSERT, UPDATE, DELETE ON "Icd11Code", "Medicine", "OrderableTest" FROM setu_app;

-- One draft and at most one current (final / amended) version per visit and note kind (ADR 0003). The sign route
-- supersedes the old version before signing the new one, inside one transaction.
CREATE UNIQUE INDEX "Composition_one_draft" ON "Composition" ("tenantId", "encounterId", "kind") WHERE "status" = 'draft';
CREATE UNIQUE INDEX "Composition_one_current" ON "Composition" ("tenantId", "encounterId", "kind") WHERE "status" IN ('final', 'amended');
ALTER TABLE "Composition" ADD CONSTRAINT composition_version_positive CHECK ("version" >= 1);
ALTER TABLE "Composition" ADD CONSTRAINT composition_amendment_shape CHECK (("version" = 1) = ("amendsId" IS NULL));
ALTER TABLE "Composition" ADD CONSTRAINT composition_amend_reason CHECK ("amendsId" IS NULL OR length(btrim(coalesce("amendReason", ''))) >= 5);
ALTER TABLE "Composition" ADD CONSTRAINT composition_signed_by CHECK ("status" IN ('draft', 'queued') OR ("signedAt" IS NOT NULL AND "signedById" IS NOT NULL));
ALTER TABLE "MedicationRequest" ADD CONSTRAINT medication_days CHECK ("days" BETWEEN 1 AND 365 AND "quantity" >= 0);

-- Rule 3 (amend, never overwrite). A Composition is never deleted. A draft may be edited; once it has left draft its
-- content is frozen and only its status may move on (final / amended → superseded / entered-in-error), with the
-- pointer to the version that replaced it. Applies to every role, the owner included.
CREATE OR REPLACE FUNCTION composition_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Composition is never deleted (rule 3)'; END IF;
  IF OLD."status" = 'draft' THEN RETURN NEW; END IF;
  IF NOT (OLD."status" IN ('final', 'amended') AND NEW."status" IN ('superseded', 'entered-in-error')) THEN
    RAISE EXCEPTION 'Composition %: a signed version cannot change from % to % (rule 3)', OLD."id", OLD."status", NEW."status";
  END IF;
  IF (NEW."sections", NEW."sectionSources", NEW."version", NEW."encounterId", NEW."patientId", NEW."tenantId", NEW."kind",
      NEW."amendsId", NEW."amendReason", NEW."authorId", NEW."signedAt", NEW."signedById", NEW."aiReviewed", NEW."rev",
      NEW."uncodedAllergiesChecked", NEW."organizationId", NEW."branchId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."sections", OLD."sectionSources", OLD."version", OLD."encounterId", OLD."patientId", OLD."tenantId", OLD."kind",
      OLD."amendsId", OLD."amendReason", OLD."authorId", OLD."signedAt", OLD."signedById", OLD."aiReviewed", OLD."rev",
      OLD."uncodedAllergiesChecked", OLD."organizationId", OLD."branchId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Composition %: a signed version is never edited — amend it (rule 3)', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER composition_guard BEFORE UPDATE OR DELETE ON "Composition" FOR EACH ROW EXECUTE FUNCTION composition_guard();
REVOKE DELETE ON "Composition" FROM setu_app;

-- Diagnoses and prescription lines belong to one version: they can be added, changed or removed only while that
-- version is a draft.
CREATE OR REPLACE FUNCTION composition_item_guard() RETURNS trigger AS $$
DECLARE st "DocumentStatus";
BEGIN
  SELECT "status" INTO st FROM "Composition" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."compositionId" ELSE NEW."compositionId" END);
  IF st IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION '%: the note version is % — items change only in a draft (rule 3)', TG_TABLE_NAME, st; END IF;
  IF TG_OP = 'UPDATE' AND NEW."compositionId" IS DISTINCT FROM OLD."compositionId" THEN RAISE EXCEPTION '%: an item cannot move to another note', TG_TABLE_NAME; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER condition_guard BEFORE INSERT OR UPDATE OR DELETE ON "Condition" FOR EACH ROW EXECUTE FUNCTION composition_item_guard();
CREATE TRIGGER medication_request_guard BEFORE INSERT OR UPDATE OR DELETE ON "MedicationRequest" FOR EACH ROW EXECUTE FUNCTION composition_item_guard();

-- Orders: created and edited only as drafts of a draft note; once placed (ORDER `order`), only the status and its
-- time change (lab slices), and an order is never deleted.
CREATE OR REPLACE FUNCTION service_request_guard() RETURNS trigger AS $$
DECLARE st "DocumentStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO st FROM "Composition" WHERE "id" = NEW."compositionId";
    IF st IS DISTINCT FROM 'draft' OR NEW."status" <> 'draft' THEN RAISE EXCEPTION 'ServiceRequest: new orders start as drafts of a draft note'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'draft' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ServiceRequest %: a placed order is never deleted (revoke it)', OLD."id"; END IF;
    IF (NEW."testCode", NEW."nameEn", NEW."nameBn", NEW."group", NEW."priority", NEW."note", NEW."encounterId", NEW."patientId",
        NEW."compositionId", NEW."orderedById", NEW."orderedAt", NEW."tenantId", NEW."organizationId", NEW."branchId", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."testCode", OLD."nameEn", OLD."nameBn", OLD."group", OLD."priority", OLD."note", OLD."encounterId", OLD."patientId",
        OLD."compositionId", OLD."orderedById", OLD."orderedAt", OLD."tenantId", OLD."organizationId", OLD."branchId", OLD."createdAt") THEN
      RAISE EXCEPTION 'ServiceRequest %: a placed order is not edited', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  SELECT "status" INTO st FROM "Composition" WHERE "id" = OLD."compositionId";
  IF st IS DISTINCT FROM 'draft' AND NOT (TG_OP = 'UPDATE' AND NEW."status" = 'active') THEN
    RAISE EXCEPTION 'ServiceRequest %: a draft order of a signed note cannot change', OLD."id";
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER service_request_guard BEFORE INSERT OR UPDATE OR DELETE ON "ServiceRequest" FOR EACH ROW EXECUTE FUNCTION service_request_guard();

-- ADR 0004: an allergy is never deleted or edited; the only change is active → entered-in-error with who, when, why.
CREATE OR REPLACE FUNCTION allergy_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AllergyIntolerance is never deleted — mark it entered-in-error (ADR 0004)'; END IF;
  IF NOT (OLD."status" = 'active' AND NEW."status" = 'entered-in-error') THEN
    RAISE EXCEPTION 'AllergyIntolerance %: only active → entered-in-error is allowed (ADR 0004)', OLD."id";
  END IF;
  IF (NEW."kind", NEW."key", NEW."labelBn", NEW."labelEn", NEW."reaction", NEW."severity", NEW."patientId", NEW."tenantId",
      NEW."organizationId", NEW."encounterId", NEW."recordedById", NEW."recordedAt")
     IS DISTINCT FROM
     (OLD."kind", OLD."key", OLD."labelBn", OLD."labelEn", OLD."reaction", OLD."severity", OLD."patientId", OLD."tenantId",
      OLD."organizationId", OLD."encounterId", OLD."recordedById", OLD."recordedAt") THEN
    RAISE EXCEPTION 'AllergyIntolerance %: content is never edited (ADR 0004)', OLD."id";
  END IF;
  IF NEW."errorById" IS NULL OR NEW."errorAt" IS NULL OR length(btrim(coalesce(NEW."errorReason", ''))) < 10 THEN
    RAISE EXCEPTION 'AllergyIntolerance %: entered-in-error needs who, when and a reason of at least 10 characters', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER allergy_guard BEFORE UPDATE OR DELETE ON "AllergyIntolerance" FOR EACH ROW EXECUTE FUNCTION allergy_guard();
REVOKE DELETE ON "AllergyIntolerance" FROM setu_app;
ALTER TABLE "AllergyIntolerance" ADD CONSTRAINT allergy_key_shape CHECK (("kind" = 'other') = ("key" IS NULL));
