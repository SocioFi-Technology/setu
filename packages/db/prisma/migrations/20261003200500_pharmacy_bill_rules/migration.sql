-- Pharmacy session 1 (ADR 0009): the rules that tie a medicine line's money to the stock it took.

-- A visit may have several pharmacy bills over time (the rest of a partial dispense is given later), but at most one
-- draft at a time; the OPD rule (one bill per visit that is not cancelled / voided) is unchanged.
DROP INDEX IF EXISTS "Invoice_one_per_encounter_kind";
CREATE UNIQUE INDEX "Invoice_one_opd_per_encounter" ON "Invoice" ("tenantId", "encounterId")
  WHERE "kind" = 'opd' AND "status" NOT IN ('cancelled', 'entered-in-error');
CREATE UNIQUE INDEX "Invoice_one_pharmacy_draft_per_encounter" ON "Invoice" ("tenantId", "encounterId")
  WHERE "kind" = 'pharmacy' AND "status" = 'draft';

-- The buyer and the prescription photo of an OTC sale are frozen once the bill leaves draft (as the kind always is).
CREATE OR REPLACE FUNCTION invoice_kind_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'Invoice %: the bill kind never changes', OLD."id";
  END IF;
  IF OLD."status" <> 'draft' AND (NEW."buyerName", NEW."buyerPhone", NEW."rxPhotoKey") IS DISTINCT FROM (OLD."buyerName", OLD."buyerPhone", OLD."rxPhotoKey") THEN
    RAISE EXCEPTION 'Invoice %: the buyer and the prescription photo change only on a draft', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- A medicine line is priced at its batch's MRP and VAT, for that batch's medicine at this facility. A dispense line is
-- written after its dispense record and the stock move that took exactly its quantity from exactly its batch.
CREATE OR REPLACE FUNCTION charge_item_medicine_guard() RETURNS trigger AS $$
DECLARE b RECORD; inv RECORD; d RECORD; moved bigint;
BEGIN
  IF NEW."source" NOT IN ('dispense', 'sale') THEN RETURN NEW; END IF;
  SELECT * INTO inv FROM "Invoice" WHERE "id" = NEW."invoiceId";
  SELECT * INTO b FROM "StockBatch" WHERE "id" = NEW."batchId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR b."organizationId" <> inv."organizationId" OR b."medicineKey" <> NEW."medicineKey" THEN
    RAISE EXCEPTION 'ChargeItem: the batch is not this medicine at this facility';
  END IF;
  IF NEW."unitPaisa" <> b."mrpPaisa" OR NEW."vatRateBp" <> b."vatRateBp" THEN
    RAISE EXCEPTION 'ChargeItem: a medicine line is priced at its batch''s MRP and VAT';
  END IF;
  IF NEW."source" = 'dispense' AND TG_OP = 'INSERT' THEN
    SELECT * INTO d FROM "MedicationDispense" WHERE "id" = NEW."sourceId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND OR d."action" <> 'dispense' OR d."medicineKey" <> NEW."medicineKey" OR d."qty" <> NEW."qty"
       OR d."invoiceId" IS DISTINCT FROM NEW."invoiceId" OR d."encounterId" IS DISTINCT FROM inv."encounterId" THEN
      RAISE EXCEPTION 'ChargeItem: a dispense line follows its dispense record';
    END IF;
    SELECT coalesce(sum("qty"), 0) INTO moved FROM "StockMove" WHERE "refType" = 'dispense' AND "refId" = d."id" AND "batchId" = NEW."batchId";
    IF moved <> -NEW."qty" THEN RAISE EXCEPTION 'ChargeItem: the dispense took % from the batch, the line says %', -moved, NEW."qty"; END IF;
  END IF;
  IF NEW."source" = 'dispense' AND TG_OP = 'UPDATE'
     AND (NEW."qty", NEW."batchId", NEW."medicineKey", NEW."sourceId", NEW."unitPaisa") IS DISTINCT FROM (OLD."qty", OLD."batchId", OLD."medicineKey", OLD."sourceId", OLD."unitPaisa") THEN
    RAISE EXCEPTION 'ChargeItem: a dispense line is what was given — it is not edited';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER charge_item_medicine_guard BEFORE INSERT OR UPDATE ON "ChargeItem" FOR EACH ROW EXECUTE FUNCTION charge_item_medicine_guard();

-- Given medicine is never taken off its bill: a dispense line is not deleted (a return comes with session 2).
CREATE OR REPLACE FUNCTION charge_item_dispense_kept() RETURNS trigger AS $$
BEGIN
  IF OLD."source" = 'dispense' THEN RAISE EXCEPTION 'ChargeItem: a dispense line is never removed (stock already left the shelf)'; END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER charge_item_dispense_kept BEFORE DELETE ON "ChargeItem" FOR EACH ROW EXECUTE FUNCTION charge_item_dispense_kept();

-- An OTC bill is issued only when each sale line's quantity has left its batch (one `sale` move per line).
CREATE OR REPLACE FUNCTION invoice_otc_issue_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ChargeItem" l
    WHERE l."invoiceId" = NEW."id" AND l."source" = 'sale'
      AND (SELECT coalesce(sum(m."qty"), 0) FROM "StockMove" m WHERE m."refType" = 'sale' AND m."refId" = l."id" AND m."batchId" = l."batchId" AND m."kind" = 'sale') <> -l."qty"
  ) THEN
    RAISE EXCEPTION 'Invoice %: every sale line''s stock moves before the bill is issued', NEW."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_otc_issue_guard BEFORE UPDATE ON "Invoice" FOR EACH ROW
  WHEN (OLD."status" = 'draft' AND NEW."status" = 'issued' AND NEW."kind" = 'otc') EXECUTE FUNCTION invoice_otc_issue_guard();

-- A dispense or sale move points at what it belongs to.
ALTER TABLE "StockMove" ADD CONSTRAINT stock_move_ref CHECK ("kind" NOT IN ('dispense', 'sale') OR ("refType" = "kind" AND "refId" IS NOT NULL));
