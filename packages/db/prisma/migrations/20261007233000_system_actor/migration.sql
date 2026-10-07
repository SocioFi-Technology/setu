-- Decision 317 (Kamrul, 07/10/2026: "a system actor is a later change" — now): what happens because of an event, not a
-- person's action, is recorded as done by the tenant's system actor instead of whoever's action or view caught it up.
-- One per tenant: no password (the hash "!" never verifies), no role, inactive — it can never sign in or hold a session.
ALTER TABLE "User" ADD COLUMN "system" BOOLEAN NOT NULL DEFAULT false;
INSERT INTO "User" ("id", "tenantId", "nameBn", "nameEn", "passwordHash", "active", "system", "createdAt")
SELECT 'sys_' || t."id", t."id", 'সেতু (সিস্টেম)', 'Setu (system)', '!', false, true, now() FROM "Tenant" t
ON CONFLICT ("id") DO NOTHING;
ALTER TABLE "User" ADD CONSTRAINT user_system_shape CHECK (NOT "system" OR ("id" = 'sys_' || "tenantId" AND NOT "active" AND "passwordHash" = '!' AND "pinHash" IS NULL));

CREATE OR REPLACE FUNCTION is_system_user(p_user text, p_tenant text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = p_user AND u."tenantId" = p_tenant AND u."system");
$$;
-- the system actor never holds a role (so no screen, no approval, no signature)
CREATE OR REPLACE FUNCTION practitioner_role_not_system() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" u WHERE u."id" = NEW."userId" AND u."system") THEN RAISE EXCEPTION 'PractitionerRole: the system actor holds no role'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER practitioner_role_not_system BEFORE INSERT OR UPDATE OF "userId" ON "PractitionerRole" FOR EACH ROW EXECUTE FUNCTION practitioner_role_not_system();

CREATE OR REPLACE FUNCTION discharge_step_guard() RETURNS trigger AS $$
DECLARE d RECORD; open_deps int;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DischargeStep %: never deleted', OLD."id"; END IF;
  SELECT * INTO d FROM "Discharge" WHERE "id" = NEW."dischargeId";
  IF NEW."byHand" AND (TG_OP = 'INSERT' OR NOT OLD."byHand") THEN RAISE EXCEPTION 'DischargeStep: steps are done by their events now — never recorded by hand (ADR 0018)'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."dischargeId", NEW."key", NEW."tenantId") IS DISTINCT FROM (OLD."dischargeId", OLD."key", OLD."tenantId") THEN RAISE EXCEPTION 'DischargeStep %: its discharge and key never change', OLD."id"; END IF;
    -- after the patient left, the steps still open (the bill, a LAMA summary) go on
    IF d."status" NOT IN ('ordered', 'completed') THEN RAISE EXCEPTION 'DischargeStep %: the discharge is %', OLD."id", d."status"; END IF;
    IF OLD."status" = 'done' AND (to_jsonb(NEW) - ARRAY['remindedById', 'remindedAt', 'reminders']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['remindedById', 'remindedAt', 'reminders']) THEN RAISE EXCEPTION 'DischargeStep %: done is final', OLD."id"; END IF;
    IF NOT ((OLD."status" = NEW."status") OR (OLD."status" = 'waiting' AND NEW."status" = 'in-progress') OR (OLD."status" = 'in-progress' AND NEW."status" = 'done')) THEN
      RAISE EXCEPTION 'DischargeStep %: cannot move from % to %', OLD."id", OLD."status", NEW."status";
    END IF;
    -- decision 317: a step finished by its event (summary, final bill, payment) is done by the tenant's system actor
    IF NEW."status" = 'done' AND OLD."status" <> 'done' AND NOT lab_actor_ok(NEW."doneById")
       AND NOT (is_system_user(NEW."doneById", NEW."tenantId") AND NEW."key" IN ('summary', 'final-bill', 'payment')) THEN
      RAISE EXCEPTION 'DischargeStep %: done by the signed-in user', OLD."id";
    END IF;
    IF NEW."takenById" IS DISTINCT FROM OLD."takenById" AND NEW."takenById" IS NOT NULL AND NOT lab_actor_ok(NEW."takenById") THEN RAISE EXCEPTION 'DischargeStep %: taken by the signed-in user', OLD."id"; END IF;
    IF NEW."remindedAt" IS DISTINCT FROM OLD."remindedAt" AND (NOT lab_actor_ok(NEW."remindedById") OR NEW."reminders" <> OLD."reminders" + 1) THEN RAISE EXCEPTION 'DischargeStep %: a reminder is counted and signed', OLD."id"; END IF;
  ELSIF d."status" <> 'ordered' THEN RAISE EXCEPTION 'DischargeStep: the discharge is %', d."status";
  END IF;
  IF discharge_step_waits(d."kind", NEW."key") IS NULL OR (d."kind" = 'death' AND NEW."key" IN ('summary', 'pharmacy')) THEN
    RAISE EXCEPTION 'DischargeStep: a % discharge has no % step', d."kind", NEW."key";
  END IF;
  IF NEW."status" <> 'waiting' AND (TG_OP = 'INSERT' OR OLD."status" = 'waiting') THEN
    SELECT count(*) INTO open_deps FROM unnest(discharge_step_waits(d."kind", NEW."key")) w(k)
      WHERE NOT EXISTS (SELECT 1 FROM "DischargeStep" s WHERE s."dischargeId" = NEW."dischargeId" AND s."key" = w.k AND s."status" = 'done');
    IF open_deps > 0 THEN RAISE EXCEPTION 'DischargeStep: % waits for its earlier steps', NEW."key"; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

