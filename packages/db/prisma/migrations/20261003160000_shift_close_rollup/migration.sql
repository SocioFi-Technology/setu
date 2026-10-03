-- Slice C1–C4 session 1 (ADR 0008): cashier shift close (Shift, ShiftCount, ShiftReview) and the owner dashboard's
-- DailyRollup. Tables from `prisma migrate diff`; guards below.

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('open', 'counted', 'closed', 'approved');

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'open',
    "openingFloatPaisa" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latestCountId" TEXT,
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftCount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "countNo" INTEGER NOT NULL,
    "counts" JSONB NOT NULL,
    "countedPaisa" INTEGER NOT NULL,
    "openingFloatPaisa" INTEGER NOT NULL,
    "cashInPaisa" INTEGER NOT NULL,
    "cashRefundPaisa" INTEGER NOT NULL DEFAULT 0,
    "expectedCashPaisa" INTEGER NOT NULL,
    "variancePaisa" INTEGER NOT NULL,
    "digitalSystem" JSONB NOT NULL,
    "digitalSettlement" JSONB NOT NULL,
    "reason" TEXT,
    "windowFrom" TIMESTAMP(3) NOT NULL,
    "windowTo" TIMESTAMP(3) NOT NULL,
    "countedById" TEXT NOT NULL,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyRollup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shift_tenantId_organizationId_status_idx" ON "Shift"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE INDEX "Shift_tenantId_cashierId_idx" ON "Shift"("tenantId", "cashierId");

-- CreateIndex
CREATE INDEX "ShiftCount_tenantId_shiftId_idx" ON "ShiftCount"("tenantId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftCount_shiftId_countNo_key" ON "ShiftCount"("shiftId", "countNo");

-- CreateIndex
CREATE INDEX "ShiftReview_tenantId_shiftId_idx" ON "ShiftReview"("tenantId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyRollup_tenantId_organizationId_day_key" ON "DailyRollup"("tenantId", "organizationId", "day");

-- AddForeignKey
ALTER TABLE "ShiftCount" ADD CONSTRAINT "ShiftCount_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftReview" ADD CONSTRAINT "ShiftReview_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


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

-- ───── one shift per cashier and facility that is not yet approved ─────
CREATE UNIQUE INDEX shift_one_unfinished ON "Shift" ("tenantId", "organizationId", "cashierId") WHERE "status" <> 'approved';
ALTER TABLE "Shift" ADD CONSTRAINT shift_float CHECK ("openingFloatPaisa" >= 0 AND "openingFloatPaisa" <= 100000000);

-- ───── Shift: opened by the cashier themself; SHIFT transitions only; what it is never changes; never deleted ─────
REVOKE DELETE ON "Shift" FROM setu_app;
CREATE OR REPLACE FUNCTION shift_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Shift %: a shift is never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'open' OR NEW."latestCountId" IS NOT NULL THEN RAISE EXCEPTION 'Shift: a new shift starts open'; END IF;
    IF NOT lab_actor_ok(NEW."cashierId") THEN RAISE EXCEPTION 'Shift: a cashier opens their own shift'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."cashierId", NEW."openingFloatPaisa", NEW."openedAt")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."cashierId", OLD."openingFloatPaisa", OLD."openedAt") THEN
    RAISE EXCEPTION 'Shift %: whose shift it is and its float never change', OLD."id";
  END IF;
  IF NEW."status" <> OLD."status" AND (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('open>counted', 'counted>closed', 'closed>approved', 'closed>open', 'counted>open') THEN
    RAISE EXCEPTION 'Shift %: SHIFT cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF OLD."status" = 'approved' THEN RAISE EXCEPTION 'Shift %: an approved shift is final', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER shift_guard BEFORE INSERT OR UPDATE OR DELETE ON "Shift" FOR EACH ROW EXECUTE FUNCTION shift_guard();

-- ───── ShiftCount / ShiftReview: append-only for every role ─────
REVOKE UPDATE, DELETE ON "ShiftCount", "ShiftReview" FROM setu_app;
CREATE OR REPLACE FUNCTION shift_record_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: a count or a decision is never changed or deleted', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER shift_count_immutable BEFORE UPDATE OR DELETE ON "ShiftCount" FOR EACH ROW EXECUTE FUNCTION shift_record_immutable();
CREATE TRIGGER shift_review_immutable BEFORE UPDATE OR DELETE ON "ShiftReview" FOR EACH ROW EXECUTE FUNCTION shift_record_immutable();

-- the arithmetic is the domain's (shift.ts): expected = float + cash in − refunds; variance = counted − expected; a
-- variance needs a reason of at least 10 characters (open question 87)
ALTER TABLE "ShiftCount" ADD CONSTRAINT shift_count_sums CHECK (
  "countedPaisa" >= 0 AND "cashInPaisa" >= 0 AND "cashRefundPaisa" >= 0 AND "openingFloatPaisa" >= 0
  AND "expectedCashPaisa" = "openingFloatPaisa" + "cashInPaisa" - "cashRefundPaisa"
  AND "variancePaisa" = "countedPaisa" - "expectedCashPaisa"
  AND ("variancePaisa" = 0 OR char_length(btrim(coalesce("reason", ''))) >= 10)
  AND "windowTo" >= "windowFrom" AND "countNo" >= 1);
ALTER TABLE "ShiftReview" ADD CONSTRAINT shift_review_shape CHECK (
  "decision" IN ('approve', 'recount') AND ("decision" <> 'recount' OR char_length(btrim(coalesce("note", ''))) >= 10));

CREATE OR REPLACE FUNCTION shift_count_guard() RETURNS trigger AS $$
DECLARE s RECORD;
BEGIN
  SELECT * INTO s FROM "Shift" WHERE "id" = NEW."shiftId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'ShiftCount: no such shift'; END IF;
  IF s."status" <> 'open' THEN RAISE EXCEPTION 'ShiftCount: only an open shift is counted'; END IF;
  IF NEW."countedById" <> s."cashierId" OR NOT lab_actor_ok(NEW."countedById") THEN RAISE EXCEPTION 'ShiftCount: the cashier counts their own drawer'; END IF;
  IF NEW."openingFloatPaisa" <> s."openingFloatPaisa" OR NEW."windowFrom" <> s."openedAt" THEN RAISE EXCEPTION 'ShiftCount: the float and the window start are the shift''s'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER shift_count_guard BEFORE INSERT ON "ShiftCount" FOR EACH ROW EXECUTE FUNCTION shift_count_guard();

CREATE OR REPLACE FUNCTION shift_review_guard() RETURNS trigger AS $$
DECLARE s RECORD; c RECORD;
BEGIN
  SELECT * INTO s FROM "Shift" WHERE "id" = NEW."shiftId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND THEN RAISE EXCEPTION 'ShiftReview: no such shift'; END IF;
  IF s."status" <> 'closed' THEN RAISE EXCEPTION 'ShiftReview: only a handed-over shift is reviewed'; END IF;
  IF NEW."byId" = s."cashierId" THEN RAISE EXCEPTION 'ShiftReview: a cashier never approves their own shift'; END IF;
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'ShiftReview: reviewed by someone other than the signed-in user'; END IF;
  IF NEW."countId" IS DISTINCT FROM s."latestCountId" THEN RAISE EXCEPTION 'ShiftReview: the decision is on the latest count'; END IF;
  SELECT * INTO c FROM "ShiftCount" WHERE "id" = NEW."countId";
  IF NEW."decision" = 'approve' AND c."variancePaisa" <> 0 AND char_length(btrim(coalesce(NEW."note", ''))) < 10 THEN
    RAISE EXCEPTION 'ShiftReview: accepting a variance needs a note (issue #24)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER shift_review_guard BEFORE INSERT ON "ShiftReview" FOR EACH ROW EXECUTE FUNCTION shift_review_guard();

ALTER TABLE "DailyRollup" ADD CONSTRAINT daily_rollup_day CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$');
REVOKE DELETE ON "DailyRollup" FROM setu_app;
