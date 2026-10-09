-- HANDOVER gap 16 (Kamrul 09/10/2026): the database's "who did it" check never passes by default.
-- lab_actor_ok() returned NULL when app.user_id was never set on the connection (NULL = uid is NULL), and
-- `IF NOT NULL` does not raise — so every guard calling it let a write with no signed-in user through, on a fresh
-- pooled connection. Now it is true or false, never NULL: an unset or empty app.user_id is nobody. Writes with no person
-- behind them (the sweeps, the gateway's callbacks) set app.user_id to the tenant's system actor (decision 317,
-- forTenant(..., { system: true })).
CREATE OR REPLACE FUNCTION lab_actor_ok(uid text) RETURNS boolean AS $$
  SELECT current_user <> 'setu_app' OR coalesce(uid IS NOT NULL AND uid = nullif(current_setting('app.user_id', true), ''), false);
$$ LANGUAGE sql STABLE;

-- The refund voucher's guard skipped the check outright when no user was set; the same rule as everywhere now.
CREATE OR REPLACE FUNCTION refund_voucher_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE r RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION '%: a refund voucher is never changed or deleted', TG_TABLE_NAME; END IF;
  SELECT * INTO r FROM "Refund" WHERE "id" = NEW."refundId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR r."status" NOT IN ('approved', 'paid') OR r."organizationId" <> NEW."organizationId" OR r."invoiceId" <> NEW."invoiceId"
     OR r."patientId" IS DISTINCT FROM NEW."patientId" OR r."amountPaisa" <> NEW."amountPaisa" THEN
    RAISE EXCEPTION 'RefundVoucher: the voucher of an approved refund, for its amount';
  END IF;
  IF NOT lab_actor_ok(NEW."createdById") THEN
    RAISE EXCEPTION 'RefundVoucher: made by someone other than the signed-in user';
  END IF;
  RETURN NEW;
END $function$;
