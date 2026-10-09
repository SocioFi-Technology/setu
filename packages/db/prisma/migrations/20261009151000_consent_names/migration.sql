-- ADR 0021: a share keeps the names it was made with — the receiving facility and doctor, and what was shared (the
-- facility, the report number or the visit's date) — so the patient's list never reads another tenant to show them.
ALTER TABLE "Consent" ADD COLUMN "granteeFacilityEn" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Consent" ADD COLUMN "granteeFacilityBn" TEXT;
ALTER TABLE "Consent" ADD COLUMN "granteeDoctorEn" TEXT;
ALTER TABLE "Consent" ADD COLUMN "granteeDoctorBn" TEXT;
ALTER TABLE "Consent" ADD COLUMN "scopeFacilityEn" TEXT;
ALTER TABLE "Consent" ADD COLUMN "scopeFacilityBn" TEXT;
ALTER TABLE "Consent" ADD COLUMN "scopeNumber" TEXT;
ALTER TABLE "Consent" ADD COLUMN "scopeAt" TIMESTAMP(3);
ALTER TABLE "Consent" ALTER COLUMN "granteeFacilityEn" DROP DEFAULT;
