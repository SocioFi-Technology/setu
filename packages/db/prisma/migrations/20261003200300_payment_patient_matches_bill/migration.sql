-- Pharmacy session 1 (ADR 0009): a payment's and a receipt's patient is exactly its bill's patient — none for a walk-in
-- over-the-counter buyer, never a different one. Replaces the placeholder CHECK of 20261003200200. Both rows are
-- already immutable after insert (billing guards), so checking on insert is enough.
ALTER TABLE "Payment" DROP CONSTRAINT payment_patient_kind;

CREATE OR REPLACE FUNCTION money_patient_matches_bill() RETURNS trigger AS $$
DECLARE bill_patient text;
BEGIN
  SELECT i."patientId" INTO bill_patient FROM "Invoice" i WHERE i."id" = NEW."invoiceId";
  IF NOT FOUND OR NEW."patientId" IS DISTINCT FROM bill_patient THEN
    RAISE EXCEPTION '% %: the patient must be the bill''s patient', TG_TABLE_NAME, NEW."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER payment_patient_matches_bill BEFORE INSERT ON "Payment" FOR EACH ROW EXECUTE FUNCTION money_patient_matches_bill();
CREATE TRIGGER receipt_patient_matches_bill BEFORE INSERT ON "Receipt" FOR EACH ROW EXECUTE FUNCTION money_patient_matches_bill();
