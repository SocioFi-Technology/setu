-- The ≥10-character reason applies to "Link anyway" only; "Send for review" may have a short reason or none.
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS task_link_reason;
ALTER TABLE "Task" ADD CONSTRAINT task_link_reason CHECK (
  "kind" <> 'patient-link-review' OR "decisionNote" IS DISTINCT FROM 'link-anyway' OR length(btrim(coalesce("reason", ''))) >= 10
);
