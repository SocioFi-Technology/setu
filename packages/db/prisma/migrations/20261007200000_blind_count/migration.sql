-- External review A5 (blind count): the cashier's count is stored and the shift moves open → counted *before* any
-- variance is shown; the reason for a variance is given afterwards, at the hand-over (counted → closed), in its own
-- append-only row. A count no longer carries the reason (rows written before keep theirs).
ALTER TABLE "ShiftCount" DROP CONSTRAINT shift_count_sums;
ALTER TABLE "ShiftCount" ADD CONSTRAINT shift_count_sums CHECK (
  "countedPaisa" >= 0 AND "cashInPaisa" >= 0 AND "cashRefundPaisa" >= 0 AND "openingFloatPaisa" >= 0
  AND "expectedCashPaisa" = "openingFloatPaisa" + "cashInPaisa" - "cashRefundPaisa"
  AND "variancePaisa" = "countedPaisa" - "expectedCashPaisa"
  AND "windowTo" >= "windowFrom" AND "countNo" >= 1);

CREATE TABLE "ShiftHandover" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "reason" TEXT,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftHandover_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShiftHandover_countId_key" ON "ShiftHandover"("countId");
CREATE INDEX "ShiftHandover_tenantId_shiftId_idx" ON "ShiftHandover"("tenantId", "shiftId");
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_countId_fkey" FOREIGN KEY ("countId") REFERENCES "ShiftCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security for the new table (same loop as rls.sql).
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
GRANT SELECT, INSERT ON "ShiftHandover" TO setu_app;
REVOKE UPDATE, DELETE ON "ShiftHandover" FROM setu_app;
CREATE TRIGGER shift_handover_immutable BEFORE UPDATE OR DELETE ON "ShiftHandover" FOR EACH ROW EXECUTE FUNCTION shift_record_immutable();

-- the hand-over: the shift's own cashier, on its latest (counted) count; a variance needs a reason of 10+ characters
CREATE OR REPLACE FUNCTION shift_handover_guard() RETURNS trigger AS $$
DECLARE s RECORD; c RECORD;
BEGIN
  SELECT * INTO s FROM "Shift" WHERE "id" = NEW."shiftId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR s."status" <> 'counted' OR s."latestCountId" IS DISTINCT FROM NEW."countId" THEN RAISE EXCEPTION 'ShiftHandover: a counted shift''s latest count is handed over'; END IF;
  IF NEW."byId" <> s."cashierId" OR NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'ShiftHandover: the cashier hands over their own drawer'; END IF;
  SELECT * INTO c FROM "ShiftCount" WHERE "id" = NEW."countId";
  IF c."variancePaisa" <> 0 AND char_length(btrim(coalesce(NEW."reason", ''))) < 10 THEN RAISE EXCEPTION 'ShiftHandover: a variance needs a reason (10+ characters)'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER shift_handover_guard BEFORE INSERT ON "ShiftHandover" FOR EACH ROW EXECUTE FUNCTION shift_handover_guard();

-- SHIFT counted → closed: a variance on the latest count closes only with its hand-over reason (a count written before
-- this change carries its own reason)
CREATE OR REPLACE FUNCTION shift_guard() RETURNS trigger AS $$
DECLARE rv RECORD; newest RECORD; c RECORD;
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
  IF OLD."status" = 'approved' THEN RAISE EXCEPTION 'Shift %: an approved shift is final', OLD."id"; END IF;
  IF NEW."status" <> OLD."status" AND (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('open>counted', 'counted>closed', 'closed>approved', 'closed>open') THEN
    RAISE EXCEPTION 'Shift %: SHIFT cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  -- the latest count changes only when counting, and only to this shift's newest count
  IF NEW."latestCountId" IS DISTINCT FROM OLD."latestCountId" THEN
    IF NOT (OLD."status" = 'open' AND NEW."status" = 'counted') THEN RAISE EXCEPTION 'Shift %: the latest count changes only when counting', OLD."id"; END IF;
    SELECT "id" INTO newest FROM "ShiftCount" WHERE "shiftId" = OLD."id" ORDER BY "countNo" DESC LIMIT 1;
    IF NOT FOUND OR newest."id" <> NEW."latestCountId" THEN RAISE EXCEPTION 'Shift %: the latest count must be this shift''s newest count', OLD."id"; END IF;
  END IF;
  IF OLD."status" = 'counted' AND NEW."status" = 'closed' THEN
    SELECT * INTO c FROM "ShiftCount" WHERE "id" = OLD."latestCountId";
    IF c."variancePaisa" <> 0 AND char_length(btrim(coalesce(c."reason", ''))) < 10
       AND NOT EXISTS (SELECT 1 FROM "ShiftHandover" h WHERE h."countId" = c."id" AND char_length(btrim(coalesce(h."reason", ''))) >= 10) THEN
      RAISE EXCEPTION 'Shift %: a variance is handed over with its reason', OLD."id";
    END IF;
  END IF;
  -- approve and recount need the owner's / admin's decision row on the latest count (never by the cashier)
  IF OLD."status" = 'closed' AND NEW."status" IN ('approved', 'open') THEN
    SELECT * INTO rv FROM "ShiftReview" WHERE "shiftId" = OLD."id" AND "countId" = OLD."latestCountId"
      AND "decision" = CASE NEW."status" WHEN 'approved' THEN 'approve' ELSE 'recount' END ORDER BY "at" DESC LIMIT 1;
    IF NOT FOUND OR rv."byId" = OLD."cashierId" THEN RAISE EXCEPTION 'Shift %: a decision on the latest count by the owner or admin is required', OLD."id"; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
