-- ADR 0017 review (slice B7–B9, session 2).
-- H1: the running IPD bill is issued or voided only by the final-bill step (B10) — until then it stays a draft, whatever
-- route reaches it (the OPD bill routes no longer reach it either).
CREATE OR REPLACE FUNCTION invoice_ipd_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD."kind" = 'ipd' AND OLD."status" = 'draft' AND NEW."status" <> 'draft' THEN
    RAISE EXCEPTION 'Invoice %: the IPD running bill stays a draft until the final bill (B10)', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_ipd_frozen BEFORE UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION invoice_ipd_frozen();

-- L2: who posted an IPD line is the signed-in user (null only for the census); a charge by hand always names them.
CREATE OR REPLACE FUNCTION charge_item_ipd_actor() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Invoice" WHERE "id" = NEW."invoiceId" AND "kind" = 'ipd') THEN RETURN NEW; END IF;
  IF NEW."addedById" IS NOT NULL AND NOT lab_actor_ok(NEW."addedById") THEN RAISE EXCEPTION 'ChargeItem: posted by the signed-in user'; END IF;
  IF NEW."source" = 'desk' AND NEW."creditOfId" IS NULL AND NEW."addedById" IS NULL THEN RAISE EXCEPTION 'ChargeItem: a charge by hand names who posted it'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER charge_item_ipd_actor BEFORE INSERT ON "ChargeItem" FOR EACH ROW EXECUTE FUNCTION charge_item_ipd_actor();
-- L2: rates and packages change only through the owner's (later) publish step — never by the app role today
REVOKE UPDATE ON "BedClassRate", "Package", "PackagePrice", "PackageItem" FROM setu_app;

-- M1: the census lists only admissions whose bill is still a running draft, and never for a time in the future.
CREATE OR REPLACE FUNCTION bed_day_sweep_targets(p_now timestamptz)
RETURNS TABLE (tenant_id text, admission_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a."tenantId", a."id" FROM "Admission" a
    JOIN "Encounter" e ON e."id" = a."encounterId" AND e."status" = 'in-progress'
    JOIN "Invoice" i ON i."id" = a."invoiceId" AND i."status" = 'draft'
  WHERE a."status" = 'admitted'
    AND ((least(p_now, now()) - interval '1 minute') AT TIME ZONE 'Asia/Dhaka')::date - ((a."admittedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date + 1
        > coalesce((SELECT max(c."dayNo") FROM "ChargeItem" c WHERE c."invoiceId" = a."invoiceId" AND c."source" = 'bed-day'), 0)
  ORDER BY a."admittedAt" DESC LIMIT 200;
$$;
