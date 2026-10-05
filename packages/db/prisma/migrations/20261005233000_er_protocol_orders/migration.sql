-- ADR 0014 addendum (decisions 243, 248 / 253): nurse protocol orders countersigned by the doctor's disposition sign;
-- the "brought by" phone at arrival.
ALTER TABLE "ServiceRequest" ADD COLUMN "protocol" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "countersignedById" TEXT, ADD COLUMN "countersignedAt" TIMESTAMP(3);
ALTER TABLE "ErVisit" ADD COLUMN "broughtByPhone" TEXT;
-- a countersignature is written once, by the signed-in user, and never removed
CREATE OR REPLACE FUNCTION service_request_countersign() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."countersignedById" IS NOT NULL OR NEW."countersignedAt" IS NOT NULL THEN RAISE EXCEPTION 'ServiceRequest: a new order is not countersigned'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."protocol" <> NEW."protocol" THEN RAISE EXCEPTION 'ServiceRequest %: protocol is set when the order is placed', OLD."id"; END IF;
  IF OLD."countersignedById" IS NOT NULL AND (NEW."countersignedById" IS DISTINCT FROM OLD."countersignedById" OR NEW."countersignedAt" IS DISTINCT FROM OLD."countersignedAt") THEN
    RAISE EXCEPTION 'ServiceRequest %: a countersignature never changes', OLD."id";
  END IF;
  IF OLD."countersignedById" IS NULL AND NEW."countersignedById" IS NOT NULL THEN
    IF NOT NEW."protocol" OR NEW."countersignedAt" IS NULL OR NOT lab_actor_ok(NEW."countersignedById") THEN RAISE EXCEPTION 'ServiceRequest %: only a protocol order is countersigned, by the signed-in doctor, with a time', OLD."id"; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER service_request_countersign BEFORE INSERT OR UPDATE ON "ServiceRequest" FOR EACH ROW EXECUTE FUNCTION service_request_countersign();
