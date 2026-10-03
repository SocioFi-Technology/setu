-- Pharmacy session 1 review fixes (security review, ADR 0009).
-- 1. The app role never updates a batch: its quantity changes only inside stock_move_apply, which now runs as the
--    function's owner (SECURITY DEFINER). Setting setu.stock_ledger by hand no longer opens a way around the ledger.
REVOKE UPDATE ON "StockBatch" FROM setu_app;
ALTER FUNCTION stock_move_apply() SECURITY DEFINER SET search_path = public;

-- 2. Medicine given is always billed: at commit, every dispense row has its bill line (the line that names it).
CREATE OR REPLACE FUNCTION medication_dispense_billed() RETURNS trigger AS $$
BEGIN
  IF NEW."action" = 'dispense' AND NOT EXISTS (
    SELECT 1 FROM "ChargeItem" l WHERE l."id" = NEW."chargeItemId" AND l."sourceId" = NEW."id" AND l."invoiceId" = NEW."invoiceId" AND l."source" = 'dispense'
  ) THEN
    RAISE EXCEPTION 'MedicationDispense %: medicine given without its bill line', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER medication_dispense_billed AFTER INSERT ON "MedicationDispense"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION medication_dispense_billed();
