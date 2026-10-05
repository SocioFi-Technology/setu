-- Kamrul, 06/10/2026: ward stock is counted like the counter, store and fridge (same STOCK_COUNT machine, frozen
-- system quantities, one open count per location): the ward nurse counts, the pharmacist or the owner decides, and the
-- self-approval rule is the same (the counter decides only as the only approver for that location, with a note). An
-- approved variance on a controlled drug — at any location — writes its register line (kind count-adjust).
ALTER TABLE "StockCount" DROP CONSTRAINT stock_count_shape;
ALTER TABLE "StockCount" ADD CONSTRAINT stock_count_shape CHECK ("location" IN ('counter', 'store', 'fridge') OR "location" ~ '^ward:[A-Za-z0-9_-]+$');

CREATE OR REPLACE FUNCTION is_count_approver(p_user text, p_org text, p_location text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = p_user AND r."organizationId" = p_org
    AND r."role"::text = ANY (CASE WHEN p_location LIKE 'ward:%' THEN ARRAY['pharmacist', 'owner'] ELSE ARRAY['owner', 'admin'] END));
$$;
CREATE OR REPLACE FUNCTION facility_count_approvers(p_org text, p_location text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT r."userId")::int FROM "PractitionerRole" r JOIN "User" u ON u."id" = r."userId"
  WHERE r."organizationId" = p_org AND u."active"
    AND r."role"::text = ANY (CASE WHEN p_location LIKE 'ward:%' THEN ARRAY['pharmacist', 'owner'] ELSE ARRAY['owner', 'admin'] END);
$$;
CREATE OR REPLACE FUNCTION stock_count_decider() RETURNS trigger AS $$
BEGIN
  IF NOT is_count_approver(NEW."decidedById", NEW."organizationId", NEW."location") THEN
    RAISE EXCEPTION 'StockCount %: decided by the owner or an admin (a ward count: the pharmacist or the owner)', NEW."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION stock_count_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'StockCount is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'counting' THEN RAISE EXCEPTION 'StockCount: a new count starts as counting'; END IF;
    -- a ward's stock is counted by a nurse of this facility, signed in
    IF NEW."location" LIKE 'ward:%' AND (NOT lab_actor_ok(NEW."createdById") OR NOT EXISTS (SELECT 1 FROM "PractitionerRole" r WHERE r."userId" = NEW."createdById" AND r."organizationId" = NEW."organizationId" AND r."role" = 'nurse')) THEN
      RAISE EXCEPTION 'StockCount: a ward count is started by a nurse of this facility';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('approved', 'rejected') THEN RAISE EXCEPTION 'StockCount %: a decided count never changes', OLD."id"; END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."location", NEW."createdById", NEW."createdAt") IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."location", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'StockCount %: what it is never changes', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'counting' AND NEW."status" = 'submitted')
    OR (OLD."status" = 'submitted' AND NEW."status" IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'StockCount %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF NEW."status" IN ('approved', 'rejected') THEN
    IF NEW."decidedById" IS NULL OR NOT lab_actor_ok(NEW."decidedById") THEN RAISE EXCEPTION 'StockCount %: decided by the signed-in owner / admin', OLD."id"; END IF;
    -- decision 234 (= 223): the person who counted decides only as the facility's only approver, with a note, flagged
    IF (NEW."decidedById" = OLD."createdById") <> NEW."selfApproved" THEN RAISE EXCEPTION 'StockCount %: self-approved exactly when the counter decides', OLD."id"; END IF;
    IF NEW."selfApproved" AND (facility_count_approvers(OLD."organizationId", OLD."location") <> 1 OR length(btrim(coalesce(NEW."decisionNote", ''))) < 10) THEN
      RAISE EXCEPTION 'StockCount %: never decided by the person who counted while another approver exists (alone: with a note)', OLD."id";
    END IF;
  ELSIF NEW."selfApproved" THEN RAISE EXCEPTION 'StockCount %: self-approval is recorded at the decision', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION controlled_register_required() RETURNS trigger AS $$
DECLARE b RECORD;
BEGIN
  IF NOT ((NEW."refType" = 'indent-issue' AND NEW."qty" < 0) OR NEW."refType" IN ('administration', 'vial-open', 'dose-error', 'count')) THEN RETURN NULL; END IF;
  SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId";
  IF EXISTS (SELECT 1 FROM "Medicine" WHERE "tenantId" = NEW."tenantId" AND "key" = b."medicineKey" AND "controlled")
     AND NOT EXISTS (SELECT 1 FROM "ControlledDrugRegister" WHERE "stockMoveId" = NEW."id") THEN
    RAISE EXCEPTION 'StockMove %: a controlled drug moves with its register line', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION controlled_register_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ControlledDrugRegister: a register line is never changed or deleted'; END IF;
  IF NOT lab_actor_ok(NEW."byId") OR NEW."kind" NOT IN ('issue', 'administer', 'vial-open', 'dose-error', 'count-adjust') OR NEW."balanceAfter" < 0 THEN RAISE EXCEPTION 'ControlledDrugRegister: by the signed-in user, a known kind, a balance'; END IF;
  IF NEW."kind" = 'dose-error' AND (NEW."administrationId" IS NULL OR NEW."qty" < 0 OR char_length(btrim(coalesce(NEW."note", ''))) < 5) THEN RAISE EXCEPTION 'ControlledDrugRegister: a dose-error line names the dose, the reason, and adds back only what was returned'; END IF;
  IF NEW."kind" = 'administer' AND (NEW."witnessId" IS NULL OR NEW."witnessId" = NEW."byId") THEN RAISE EXCEPTION 'ControlledDrugRegister: a controlled dose is witnessed by someone else'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
