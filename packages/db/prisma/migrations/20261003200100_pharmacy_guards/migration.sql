-- Pharmacy session 1 (ADR 0009): guards for bill kinds, medicine lines, the stock ledger and dispenses.

-- ───── bills: one open bill per visit and kind; an otc bill has no visit; the kind never changes ─────
DROP INDEX IF EXISTS "Invoice_one_per_encounter";
CREATE UNIQUE INDEX "Invoice_one_per_encounter_kind" ON "Invoice" ("tenantId", "encounterId", "kind")
  WHERE "status" NOT IN ('cancelled', 'entered-in-error') AND "encounterId" IS NOT NULL;
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_kind_shape CHECK (
  ("kind" = 'otc' AND "encounterId" IS NULL)
  OR ("kind" <> 'otc' AND "encounterId" IS NOT NULL AND "patientId" IS NOT NULL AND "buyerName" IS NULL AND "buyerPhone" IS NULL AND "rxPhotoKey" IS NULL));
CREATE OR REPLACE FUNCTION invoice_kind_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."buyerName" IS DISTINCT FROM OLD."buyerName" AND OLD."status" <> 'draft' THEN
    RAISE EXCEPTION 'Invoice %: the bill kind never changes; the buyer only on a draft', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_kind_immutable BEFORE UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION invoice_kind_immutable();
-- a voided bill is replaced only by a bill of the same visit and kind
CREATE OR REPLACE FUNCTION invoice_replacement_ok(p_old "Invoice", p_new_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Invoice" n WHERE n."id" = p_new_id AND n."encounterId" = p_old."encounterId" AND n."kind" = p_old."kind"
                   AND n."id" <> p_old."id" AND n."number" IS NOT NULL AND n."status" NOT IN ('draft', 'cancelled', 'entered-in-error'));
$$;

-- ───── medicine lines: a batch and a medicine; dispense lines only on a pharmacy bill, sale lines only on an otc bill;
--       an opd bill has none ─────
ALTER TABLE "ChargeItem" ADD CONSTRAINT charge_item_medicine CHECK (
  ("source" IN ('dispense', 'sale')) = ("batchId" IS NOT NULL AND "medicineKey" IS NOT NULL AND "unitPaisa" IS NOT NULL));
CREATE OR REPLACE FUNCTION charge_item_kind_guard() RETURNS trigger AS $$
DECLARE k "InvoiceKind";
BEGIN
  SELECT "kind" INTO k FROM "Invoice" WHERE "id" = NEW."invoiceId";
  IF NEW."source" = 'dispense' AND k <> 'pharmacy' THEN RAISE EXCEPTION 'ChargeItem: a dispense line belongs on the visit''s pharmacy bill'; END IF;
  IF NEW."source" = 'sale' AND k <> 'otc' THEN RAISE EXCEPTION 'ChargeItem: a sale line belongs on an over-the-counter bill'; END IF;
  IF NEW."source" NOT IN ('dispense', 'sale') AND k <> 'opd' THEN RAISE EXCEPTION 'ChargeItem: a pharmacy bill holds medicine lines only'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER charge_item_kind_guard BEFORE INSERT OR UPDATE ON "ChargeItem" FOR EACH ROW EXECUTE FUNCTION charge_item_kind_guard();

-- ───── stock: a batch starts empty; what it is never changes; its quantity moves only with the ledger, never below
--       zero; the ledger is append-only for every role ─────
ALTER TABLE "StockBatch" ADD CONSTRAINT stock_batch_shape CHECK (
  "qtyOnHand" >= 0 AND "costPaisa" >= 0 AND "mrpPaisa" >= 0 AND "vatRateBp" BETWEEN 0 AND 10000
  AND "expiry" ~ '^\d{4}-\d{2}-\d{2}$' AND "location" IN ('counter', 'store', 'fridge', 'quarantine'));
REVOKE DELETE ON "StockBatch" FROM setu_app;
CREATE OR REPLACE FUNCTION stock_batch_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'StockBatch %: a batch is never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."qtyOnHand" <> 0 THEN RAISE EXCEPTION 'StockBatch: a batch starts empty — stock arrives through a receive move'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."medicineKey", NEW."batchNo", NEW."expiry", NEW."location", NEW."costPaisa", NEW."mrpPaisa", NEW."vatRateBp", NEW."sample")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."medicineKey", OLD."batchNo", OLD."expiry", OLD."location", OLD."costPaisa", OLD."mrpPaisa", OLD."vatRateBp", OLD."sample") THEN
    RAISE EXCEPTION 'StockBatch %: what a batch is never changes', OLD."id";
  END IF;
  IF NEW."qtyOnHand" <> OLD."qtyOnHand" AND coalesce(current_setting('setu.stock_ledger', true), '') <> 'on' THEN
    RAISE EXCEPTION 'StockBatch %: the quantity changes only through the stock ledger', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON "StockBatch" FOR EACH ROW EXECUTE FUNCTION stock_batch_guard();

ALTER TABLE "StockMove" ADD CONSTRAINT stock_move_shape CHECK (
  "qty" <> 0 AND "kind" IN ('receive', 'dispense', 'sale', 'adjust', 'return', 'transfer')
  AND ("kind" NOT IN ('dispense', 'sale') OR "qty" < 0) AND ("kind" <> 'receive' OR "qty" > 0)
  AND ("kind" <> 'adjust' OR char_length(btrim(coalesce("reason", ''))) >= 10));
REVOKE UPDATE, DELETE ON "StockMove", "MedicationDispense" FROM setu_app;
CREATE OR REPLACE FUNCTION pharmacy_record_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: a stock move or a dispense is never changed or deleted', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_move_immutable BEFORE UPDATE OR DELETE ON "StockMove" FOR EACH ROW EXECUTE FUNCTION pharmacy_record_immutable();
CREATE TRIGGER medication_dispense_immutable BEFORE UPDATE OR DELETE ON "MedicationDispense" FOR EACH ROW EXECUTE FUNCTION pharmacy_record_immutable();
CREATE OR REPLACE FUNCTION stock_move_apply() RETURNS trigger AS $$
DECLARE b RECORD;
BEGIN
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'StockMove: recorded by someone other than the signed-in user'; END IF;
  SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId" AND "tenantId" = NEW."tenantId" FOR UPDATE;
  IF NOT FOUND OR b."organizationId" <> NEW."organizationId" THEN RAISE EXCEPTION 'StockMove: the batch is not at this facility'; END IF;
  IF b."qtyOnHand" + NEW."qty" < 0 THEN RAISE EXCEPTION 'StockMove: batch % holds % — cannot take %', b."batchNo", b."qtyOnHand", -NEW."qty"; END IF;
  PERFORM set_config('setu.stock_ledger', 'on', true);
  UPDATE "StockBatch" SET "qtyOnHand" = "qtyOnHand" + NEW."qty" WHERE "id" = NEW."batchId";
  PERFORM set_config('setu.stock_ledger', 'off', true);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_move_apply BEFORE INSERT ON "StockMove" FOR EACH ROW EXECUTE FUNCTION stock_move_apply();

-- ───── dispenses: by the signed-in user, on a line of a signed current note of that visit; a substitute or a decline
--       needs a reason ≥ 10 ─────
ALTER TABLE "MedicationDispense" ADD CONSTRAINT medication_dispense_shape CHECK (
  ("action" = 'dispense' AND "qty" > 0) OR ("action" = 'decline' AND "qty" = 0 AND char_length(btrim(coalesce("reason", ''))) >= 10));
ALTER TABLE "MedicationDispense" ADD CONSTRAINT medication_dispense_substitute CHECK (
  "medicineKey" = "prescribedKey" OR char_length(btrim(coalesce("reason", ''))) >= 10);
CREATE OR REPLACE FUNCTION medication_dispense_guard() RETURNS trigger AS $$
DECLARE c RECORD; r RECORD;
BEGIN
  IF NOT lab_actor_ok(NEW."byId") THEN RAISE EXCEPTION 'MedicationDispense: recorded by someone other than the signed-in user'; END IF;
  SELECT * INTO c FROM "Composition" WHERE "id" = NEW."compositionId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR c."status" NOT IN ('final', 'amended') OR c."encounterId" <> NEW."encounterId" OR c."patientId" <> NEW."patientId" OR c."organizationId" <> NEW."organizationId" THEN
    RAISE EXCEPTION 'MedicationDispense: only a signed, current prescription of this visit is dispensed';
  END IF;
  SELECT * INTO r FROM "MedicationRequest" WHERE "id" = NEW."requestId" AND "compositionId" = NEW."compositionId";
  IF NOT FOUND OR r."medicineKey" <> NEW."prescribedKey" THEN RAISE EXCEPTION 'MedicationDispense: the line is not on this prescription'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER medication_dispense_guard BEFORE INSERT ON "MedicationDispense" FOR EACH ROW EXECUTE FUNCTION medication_dispense_guard();
