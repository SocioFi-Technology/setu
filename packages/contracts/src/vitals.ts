/* Vitals contracts (slice A4). Limits and interpretations live in @setu/domain vitals.ts; the API re-runs them and
   refuses a batch with any impossible value. A batch is stored only when the server answers; until then the device
   shows "Saved on this device · not synced". */
import { z } from "zod";
import { EncounterStatus, PatientSummary } from "./frontdesk.js";

const Num = z.number().finite();
export const VitalsValues = z.object({
  bpSys: Num.optional(), bpDia: Num.optional(), pulse: Num.optional(), temp: Num.optional(), spo2: Num.optional(),
  rbs: Num.optional(), rbsMode: z.enum(["random", "fasting"]).optional(), weight: Num.optional(), height: Num.optional(),
});
export type VitalsValues = z.infer<typeof VitalsValues>;

/* POST /v1/encounters/:id/vitals */
export const VitalsBatchRequest = z.object({
  values: VitalsValues,
  /** When it was measured on the device (ISO). Offline saves keep their real time. */
  effectiveAt: z.string().datetime(),
  deviceLabel: z.string().max(60).optional(),
  /** Fields the person re-checked after a "check the unit" warning (e.g. glucose 25–40 mmol/L); required for those. */
  confirmed: z.array(z.enum(["bp", "pulse", "temp", "spo2", "rbs", "weight", "height"])).max(7).optional(),
});
export type VitalsBatchRequest = z.infer<typeof VitalsBatchRequest>;

export const Interpretation = z.enum(["N", "H", "L", "HH", "LL"]);
export const ObservationItem = z.object({
  code: z.string(),
  value: z.number(),
  unit: z.string(),
  method: z.string().nullable(),
  interpretation: Interpretation.nullable(),
});
export const VitalsBatch = z.object({
  batchId: z.string(),
  effectiveAt: z.string(),
  recordedAt: z.string(),
  recordedBy: z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string(), role: z.string().nullable() }),
  /** From the batch's Provenance row: provider-verified = measured by staff at this facility. */
  source: z.enum(["provider-verified", "patient-uploaded", "patient-reported", "ai-draft", "desk-decision"]),
  observations: z.array(ObservationItem),
});
export type VitalsBatch = z.infer<typeof VitalsBatch>;

export const VitalsEncounter = z.object({
  id: z.string(),
  token: z.string(),
  day: z.string(),
  status: EncounterStatus,
  patient: PatientSummary.pick({ id: true, facilityNo: true, nameBn: true, nameEn: true, sex: true, birthDate: true, approxAgeYears: true, approxAgeMonths: true, approxAgeAt: true, identityConfidence: true }),
});
export const VitalsBatchResponse = z.object({ encounter: VitalsEncounter, batch: VitalsBatch });
export type VitalsBatchResponse = z.infer<typeof VitalsBatchResponse>;

/* GET /v1/encounters/:id/vitals — this visit's latest batch and the patient's previous values ("last: 145/90 · 12/08"). */
export const VitalsView = z.object({
  encounter: VitalsEncounter,
  current: VitalsBatch.nullable(),
  /** Latest value per code from earlier visits, with when it was measured. */
  previous: z.array(z.object({ code: z.string(), value: z.number(), unit: z.string(), effectiveAt: z.string() })),
});
export type VitalsView = z.infer<typeof VitalsView>;

/* GET /v1/vitals/worklist — today's waiting visits at the session's branch, for the vitals station. */
export const VitalsWorklist = z.object({
  day: z.string(),
  items: z.array(VitalsEncounter.extend({ hasVitals: z.boolean() })),
});
export type VitalsWorklist = z.infer<typeof VitalsWorklist>;
