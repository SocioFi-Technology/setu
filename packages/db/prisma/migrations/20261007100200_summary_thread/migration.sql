-- ADR 0018 (B11): the discharge summary is a thread of versions like the ward round note (amend, never overwrite).
ALTER TABLE "Composition" DROP CONSTRAINT composition_thread;
ALTER TABLE "Composition" ADD CONSTRAINT composition_thread CHECK (("kind" IN ('progress-note', 'discharge-summary')) = ("threadId" IS NOT NULL));
-- one discharge summary thread per inpatient visit
CREATE UNIQUE INDEX "Composition_one_summary_thread" ON "Composition" ("encounterId") WHERE "kind" = 'discharge-summary' AND "version" = 1;
