-- ADR 0014 guards (second migration: the enum value and the tables above are committed first).
-- Beds: one live (reserved or occupied) assignment per bed; one occupied and one reserved assignment per patient
-- (a move holds a reservation on the destination while the source is still occupied — never two occupied beds);
-- one open inpatient encounter per patient; one requested admission per patient; one live IPD bill per encounter.
CREATE UNIQUE INDEX "BedAssignment_one_live_per_bed" ON "BedAssignment"("tenantId", "bedId") WHERE "status" IN ('reserved', 'occupied');
CREATE UNIQUE INDEX "BedAssignment_one_occupied_per_patient" ON "BedAssignment"("tenantId", "patientId") WHERE "status" = 'occupied';
CREATE UNIQUE INDEX "BedAssignment_one_reserved_per_patient" ON "BedAssignment"("tenantId", "patientId") WHERE "status" = 'reserved';
CREATE UNIQUE INDEX "Encounter_one_open_inpatient_per_patient" ON "Encounter"("tenantId", "patientId") WHERE "class" = 'ipd' AND "status" IN ('planned', 'arrived', 'triaged', 'in-progress');
CREATE UNIQUE INDEX "Admission_one_requested_per_patient" ON "Admission"("tenantId", "patientId") WHERE "status" = 'requested';
CREATE UNIQUE INDEX "Invoice_one_live_ipd_per_encounter" ON "Invoice"("tenantId", "encounterId") WHERE "kind" = 'ipd' AND "status" NOT IN ('cancelled', 'entered-in-error');

-- Location.bedState agrees with the live assignment at commit: reserved ⇔ a reserved row, occupied (or
-- discharge-pending) ⇔ an occupied row, anything else ⇔ no live row. Checked from both sides, deferred.
CREATE OR REPLACE FUNCTION bed_consistent(bid text) RETURNS void AS $$
DECLARE b RECORD; live RECORD;
BEGIN
  SELECT * INTO b FROM "Location" WHERE "id" = bid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bed %: not found', bid; END IF;
  IF b."kind" <> 'bed' THEN RAISE EXCEPTION 'Bed %: % is not a bed', bid, b."kind"; END IF;
  SELECT "status", "patientId", "tenantId" INTO live FROM "BedAssignment" WHERE "bedId" = bid AND "status" IN ('reserved', 'occupied');
  IF NOT FOUND THEN
    IF b."bedState" IN ('reserved', 'occupied') THEN RAISE EXCEPTION 'Bed %: % with nobody assigned', bid, b."bedState"; END IF;
  ELSE
    IF live."tenantId" <> b."tenantId" THEN RAISE EXCEPTION 'Bed %: assignment from another tenant', bid; END IF;
    IF live."status" = 'reserved' AND b."bedState" <> 'reserved' THEN RAISE EXCEPTION 'Bed %: reserved for a patient but the bed is %', bid, b."bedState"; END IF;
    IF live."status" = 'occupied' AND b."bedState" NOT IN ('occupied', 'discharge_pending') THEN RAISE EXCEPTION 'Bed %: occupied by a patient but the bed is %', bid, b."bedState"; END IF;
  END IF;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION bed_assignment_consistent() RETURNS trigger AS $$
BEGIN
  PERFORM bed_consistent(NEW."bedId");
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER bed_assignment_consistent AFTER INSERT OR UPDATE ON "BedAssignment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bed_assignment_consistent();
CREATE OR REPLACE FUNCTION bed_location_consistent() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" = 'bed' THEN PERFORM bed_consistent(NEW."id"); END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER bed_location_consistent AFTER INSERT OR UPDATE OF "bedState", "kind" ON "Location" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bed_location_consistent();

-- An assignment only moves forward (reserved → occupied | ended; occupied → ended), is never deleted, and the
-- "who" columns the API writes are the signed-in user (lab_actor_ok, security L1). Its bed must be a bed of its facility.
CREATE OR REPLACE FUNCTION bed_assignment_guard() RETURNS trigger AS $$
DECLARE b RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'BedAssignment %: never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO b FROM "Location" WHERE "id" = NEW."bedId";
    IF NOT FOUND OR b."kind" <> 'bed' OR b."organizationId" <> NEW."organizationId" OR b."tenantId" <> NEW."tenantId" THEN RAISE EXCEPTION 'BedAssignment: the bed is not a bed of this facility'; END IF;
    IF NEW."status" = 'ended' THEN RAISE EXCEPTION 'BedAssignment: a new assignment is reserved or occupied'; END IF;
    IF NEW."status" = 'reserved' AND (NEW."reservedAt" IS NULL OR NOT lab_actor_ok(NEW."reservedById")) THEN RAISE EXCEPTION 'BedAssignment: a reservation records who reserved it'; END IF;
    IF NEW."status" = 'occupied' AND (NEW."occupiedAt" IS NULL OR NOT lab_actor_ok(NEW."occupiedById")) THEN RAISE EXCEPTION 'BedAssignment: an occupation records who placed the patient'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."tenantId" <> NEW."tenantId" OR OLD."bedId" <> NEW."bedId" OR OLD."patientId" <> NEW."patientId" OR OLD."encounterId" <> NEW."encounterId" OR OLD."transferId" <> NEW."transferId" THEN
    RAISE EXCEPTION 'BedAssignment %: the bed, patient, visit and transfer never change', OLD."id";
  END IF;
  IF OLD."status" = 'ended' THEN RAISE EXCEPTION 'BedAssignment %: an ended assignment never changes', OLD."id"; END IF;
  IF OLD."status" = 'occupied' AND NEW."status" <> 'ended' THEN RAISE EXCEPTION 'BedAssignment %: occupied only ends', OLD."id"; END IF;
  IF NEW."status" = 'occupied' AND OLD."status" <> 'occupied' AND (NEW."occupiedAt" IS NULL OR NOT lab_actor_ok(NEW."occupiedById")) THEN RAISE EXCEPTION 'BedAssignment: an occupation records who placed the patient'; END IF;
  IF NEW."status" = 'ended' AND (NEW."endedAt" IS NULL OR NEW."endReason" IS NULL OR NOT lab_actor_ok(NEW."endedById")) THEN RAISE EXCEPTION 'BedAssignment: an end records who ended it and why'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bed_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON "BedAssignment" FOR EACH ROW EXECUTE FUNCTION bed_assignment_guard();
REVOKE DELETE ON "BedAssignment" FROM setu_app;
REVOKE DELETE ON "ErVisit" FROM setu_app;
REVOKE DELETE ON "Admission" FROM setu_app;

-- An ER encounter has its ErVisit and an inpatient encounter its Admission at commit; an IPD bill is opened by an
-- admission and nowhere else (the admission that holds it names it and is admitted on that encounter).
CREATE OR REPLACE FUNCTION encounter_class_rows() RETURNS trigger AS $$
BEGIN
  IF NEW."class" = 'er' AND NOT EXISTS (SELECT 1 FROM "ErVisit" WHERE "encounterId" = NEW."id") THEN RAISE EXCEPTION 'Encounter %: an ER visit has its ER record', NEW."id"; END IF;
  IF NEW."class" = 'ipd' AND NOT EXISTS (SELECT 1 FROM "Admission" WHERE "encounterId" = NEW."id" AND "status" = 'admitted') THEN RAISE EXCEPTION 'Encounter %: an inpatient encounter is made by an admission', NEW."id"; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER encounter_class_rows AFTER INSERT ON "Encounter" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION encounter_class_rows();
CREATE OR REPLACE FUNCTION invoice_ipd_from_admission() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" = 'ipd' AND NOT EXISTS (SELECT 1 FROM "Admission" WHERE "invoiceId" = NEW."id" AND "encounterId" = NEW."encounterId" AND "status" = 'admitted' AND "tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'Invoice %: an IPD bill is opened by the admission and nowhere else', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_ipd_from_admission AFTER INSERT ON "Invoice" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_ipd_from_admission();
-- an admission that is admitted names its encounter, number, bed and bill; the request / admit "who" is the session user
CREATE OR REPLACE FUNCTION admission_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Admission %: never deleted', OLD."id"; END IF;
  IF NEW."source" NOT IN ('opd', 'er', 'direct') OR NEW."status" NOT IN ('requested', 'admitted', 'cancelled') THEN RAISE EXCEPTION 'Admission: unknown source or status'; END IF;
  IF TG_OP = 'INSERT' AND NOT lab_actor_ok(NEW."requestedById") THEN RAISE EXCEPTION 'Admission: requested by the signed-in user'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('admitted', 'cancelled') AND NEW."status" <> OLD."status" THEN RAISE EXCEPTION 'Admission %: % is final', OLD."id", OLD."status"; END IF;
  IF NEW."status" = 'admitted' AND (NEW."encounterId" IS NULL OR NEW."number" IS NULL OR NEW."admittedAt" IS NULL OR NOT lab_actor_ok(NEW."admittedById")) THEN
    RAISE EXCEPTION 'Admission %: admitted = encounter, number, time and who', NEW."id";
  END IF;
  IF NEW."status" <> 'admitted' AND (NEW."encounterId" IS NOT NULL OR NEW."invoiceId" IS NOT NULL) THEN RAISE EXCEPTION 'Admission %: only an admitted admission has an encounter and a bill', NEW."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER admission_guard BEFORE INSERT OR UPDATE OR DELETE ON "Admission" FOR EACH ROW EXECUTE FUNCTION admission_guard();
