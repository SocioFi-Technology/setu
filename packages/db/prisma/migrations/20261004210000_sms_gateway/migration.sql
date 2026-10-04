-- AlterTable
ALTER TABLE "Communication" ADD COLUMN     "deliveryConfirmed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "paymentId" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "smsTestSentAt" TIMESTAMP(3);


-- ADR 0012: the payment a payment-link SMS carries never changes either (what was sent and to whom)
CREATE OR REPLACE FUNCTION communication_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Communication %: a message record is never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'preparation' OR NEW."attempts" <> 0 THEN RAISE EXCEPTION 'Communication: a new message starts in preparation'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."patientId", NEW."encounterId", NEW."kind", NEW."channel", NEW."recipientUserId", NEW."toPhone", NEW."templateKey", NEW."text",
      NEW."reportId", NEW."specimenId", NEW."serviceRequestId", NEW."observationId", NEW."createdById", NEW."createdAt", NEW."paymentId")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."patientId", OLD."encounterId", OLD."kind", OLD."channel", OLD."recipientUserId", OLD."toPhone", OLD."templateKey", OLD."text",
      OLD."reportId", OLD."specimenId", OLD."serviceRequestId", OLD."observationId", OLD."createdById", OLD."createdAt", OLD."paymentId") THEN
    RAISE EXCEPTION 'Communication %: what was sent and to whom never changes', OLD."id";
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('preparation>in-progress', 'in-progress>completed', 'in-progress>failed', 'failed>preparation') THEN
    RAISE EXCEPTION 'Communication %: COMMUNICATION cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF NEW."attempts" <> OLD."attempts" + (CASE WHEN NEW."status" = 'in-progress' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'Communication %: each send counts one attempt', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- open question 124 / ADR 0012: SMS left queued (> 1 min) or sending (> 2 min), across tenants — ids only
CREATE OR REPLACE FUNCTION sms_sweep_targets(p_queued_before timestamptz, p_sending_before timestamptz)
RETURNS TABLE (tenant_id text, communication_id text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c."tenantId", c."id", c."status"::text FROM "Communication" c
  WHERE c."channel" = 'sms' AND (
    (c."status" = 'preparation' AND c."statusAt" < p_queued_before AT TIME ZONE 'UTC') OR
    (c."status" = 'in-progress' AND COALESCE(c."sentAt", c."statusAt") < p_sending_before AT TIME ZONE 'UTC'))
  ORDER BY c."statusAt" LIMIT 200;
$$;
REVOKE ALL ON FUNCTION sms_sweep_targets(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sms_sweep_targets(timestamptz, timestamptz) TO setu_app;
