-- ADR 0021: the patient app marks the facility's notice read (Communication.readAt); the message guard lets only that
-- through, once, on a patient-app message — what was sent, to whom, and its status never change by it.
CREATE OR REPLACE FUNCTION communication_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Communication %: a message record is never deleted', OLD."id"; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'preparation' OR NEW."attempts" <> 0 THEN RAISE EXCEPTION 'Communication: a new message starts in preparation'; END IF;
    IF NEW."compositionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Composition" c WHERE c."id" = NEW."compositionId" AND c."patientId" = NEW."patientId" AND c."status" IN ('final', 'amended')) THEN
      RAISE EXCEPTION 'Communication: a document made available is a signed one of this patient';
    END IF;
    RETURN NEW;
  END IF;
  -- ADR 0021: the patient opening an app notice — readAt set once on a patient-app message, nothing else changes
  IF NEW."readAt" IS DISTINCT FROM OLD."readAt" THEN
    IF OLD."readAt" IS NOT NULL OR NEW."readAt" IS NULL OR OLD."channel" <> 'patient-app'
       OR (to_jsonb(NEW) - 'readAt') IS DISTINCT FROM (to_jsonb(OLD) - 'readAt') THEN
      RAISE EXCEPTION 'Communication %: only a patient-app notice is marked read, once, and nothing else with it', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."organizationId", NEW."patientId", NEW."encounterId", NEW."kind", NEW."channel", NEW."recipientUserId", NEW."toPhone", NEW."templateKey", NEW."text",
      NEW."reportId", NEW."specimenId", NEW."serviceRequestId", NEW."observationId", NEW."createdById", NEW."createdAt", NEW."paymentId", NEW."compositionId")
     IS DISTINCT FROM (OLD."tenantId", OLD."organizationId", OLD."patientId", OLD."encounterId", OLD."kind", OLD."channel", OLD."recipientUserId", OLD."toPhone", OLD."templateKey", OLD."text",
      OLD."reportId", OLD."specimenId", OLD."serviceRequestId", OLD."observationId", OLD."createdById", OLD."createdAt", OLD."paymentId", OLD."compositionId") THEN
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
