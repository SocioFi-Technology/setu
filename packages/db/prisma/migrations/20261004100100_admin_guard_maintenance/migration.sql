-- Admin (ADR 0010): the go-live guard binds the app; the seed and maintenance scripts (owner role) may put the E2E test
-- facility back into setup so the onboarding journey runs again.
CREATE OR REPLACE FUNCTION organization_status_guard() RETURNS trigger AS $$
BEGIN
  IF current_user <> 'setu_app' THEN RETURN NEW; END IF;
  IF OLD."status" = 'live' AND NEW."status" = 'setup' THEN RAISE EXCEPTION 'Organization %: a live facility never goes back to setup', OLD."id"; END IF;
  IF OLD."liveAt" IS NOT NULL AND NEW."liveAt" IS DISTINCT FROM OLD."liveAt" THEN RAISE EXCEPTION 'Organization %: the go-live time never changes', OLD."id"; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
