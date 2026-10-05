-- ADR 0015 clinical-safety review: re-escalation. A first red parameter re-notifies the doctor even at the same total
-- (peakRed), and a worse patient after the doctor was informed goes back to raised so the nurse logs a new contact.
ALTER TABLE "EscalationEvent" ADD COLUMN "peakRed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EscalationEvent" DISABLE TRIGGER escalation_guard;
UPDATE "EscalationEvent" SET "peakRed" = "red";
ALTER TABLE "EscalationEvent" ENABLE TRIGGER escalation_guard;

CREATE OR REPLACE FUNCTION escalation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'EscalationEvent: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'raised' OR NEW."informedAt" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL OR NOT lab_actor_ok(NEW."raisedById") THEN RAISE EXCEPTION 'EscalationEvent: raised by the signed-in user'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."encounterId", NEW."patientId", NEW."observationId", NEW."raisedAt", NEW."raisedById", NEW."score", NEW."red")
     IS DISTINCT FROM (OLD."tenantId", OLD."encounterId", OLD."patientId", OLD."observationId", OLD."raisedAt", OLD."raisedById", OLD."score", OLD."red") THEN
    RAISE EXCEPTION 'EscalationEvent %: what raised it never changes', OLD."id";
  END IF;
  IF NEW."peakScore" < OLD."peakScore" THEN RAISE EXCEPTION 'EscalationEvent %: the peak only rises', OLD."id"; END IF;
  IF OLD."peakRed" AND NOT NEW."peakRed" THEN RAISE EXCEPTION 'EscalationEvent %: a red parameter seen stays seen', OLD."id"; END IF;
  IF OLD."status" = 'resolved' THEN RAISE EXCEPTION 'EscalationEvent %: resolved is final', OLD."id"; END IF;
  IF NEW."status" = 'doctor-informed' AND OLD."status" = 'raised' AND (NEW."informedAt" IS NULL OR char_length(btrim(coalesce(NEW."spokeTo", ''))) < 3 OR char_length(btrim(coalesce(NEW."instruction", ''))) < 3 OR NOT lab_actor_ok(NEW."informedById")) THEN
    RAISE EXCEPTION 'EscalationEvent %: logged with whom, the instruction and who logged it', OLD."id";
  END IF;
  IF NEW."status" = 'resolved' AND (OLD."status" <> 'doctor-informed' OR NEW."resolvedAt" IS NULL OR char_length(btrim(coalesce(NEW."resolveNote", ''))) < 3 OR NOT lab_actor_ok(NEW."resolvedById")) THEN
    RAISE EXCEPTION 'EscalationEvent %: resolved after the doctor was informed, with a note', OLD."id";
  END IF;
  -- back to raised only when the patient is worse after the doctor was informed (a higher score, or a first red parameter)
  IF NEW."status" = 'raised' AND OLD."status" <> 'raised'
     AND NOT (OLD."status" = 'doctor-informed' AND (NEW."peakScore" > OLD."peakScore" OR (NEW."peakRed" AND NOT OLD."peakRed"))) THEN
    RAISE EXCEPTION 'EscalationEvent %: back to raised only when worse after the doctor was informed', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
