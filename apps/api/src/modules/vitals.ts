/* Vitals service (slice A4). Runs inside command()/query(), so RLS scopes it to the session's tenant; visits are also
   scoped to the session's facility and branch. A batch is checked with @setu/domain assessVitals (the screen runs the
   same function): any impossible value refuses the whole batch; abnormal values are stored with their interpretation. */
import type { VitalsBatch, VitalsBatchRequest, VitalsValues } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { ENCOUNTER, assessVitals, bpComponents, dhakaDay, format, transition, type EncounterState, type VitalField } from "@setu/domain";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { branchOf, notFound } from "./frontdesk.js";
import { deliverInApp } from "./lab.js";

const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
type DbEncounterStatus = "planned" | "arrived" | "triaged" | "in_progress" | "finished" | "cancelled" | "entered_in_error";

/* Setu observation codes (not LOINC: mapping comes with the FHIR export). */
const CODE = {
  bpSys: ["bp-systolic", "mmHg"], bpDia: ["bp-diastolic", "mmHg"], pulse: ["pulse", "/min"], temp: ["body-temperature", "[degF]"],
  spo2: ["spo2", "%"], rbs: ["blood-glucose", "mmol/L"], weight: ["body-weight", "kg"], height: ["body-height", "cm"],
} as const satisfies Record<Exclude<keyof VitalsValues, "rbsMode">, readonly [string, string]>;
const FIELD_OF: Record<keyof typeof CODE, VitalField> = { bpSys: "bp", bpDia: "bp", pulse: "pulse", temp: "temp", spo2: "spo2", rbs: "rbs", weight: "weight", height: "height" };
/** How far the device's "measured at" may differ from the server's clock (offline saves wait up to the outbox's 24 h). */
const MAX_FUTURE_MS = 5 * 60_000, MAX_PAST_MS = 24 * 3600_000;

const encInclude = { patient: true } as const;
type EncRow = NonNullable<Awaited<ReturnType<Tx["encounter"]["findFirst"]>>> & { patient: NonNullable<Awaited<ReturnType<Tx["patient"]["findFirst"]>>> };
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const toVitalsEncounter = (e: EncRow) => ({
  id: e.id, token: e.token, day: e.tokenDay, status: dash<EncounterState>(e.status),
  patient: {
    id: e.patient.id, facilityNo: e.patient.facilityNo, nameBn: e.patient.nameBn, nameEn: e.patient.nameEn, sex: e.patient.sex,
    birthDate: e.patient.birthDate ? e.patient.birthDate.toISOString().slice(0, 10) : null, approxAgeYears: e.patient.approxAgeYears,
    approxAgeMonths: e.patient.approxAgeMonths, approxAgeAt: iso(e.patient.approxAgeAt), identityConfidence: dash<"verified">(e.patient.identityConfidence),
  },
});

/** A visit at the session's facility and branch, or 404 (another tenant's or another branch's visit is not found). */
export async function encounterHere(tx: Tx, s: SessionData, id: string): Promise<EncRow> {
  const branch = await branchOf(tx, s);
  const e = await tx.encounter.findFirst({ where: { id, organizationId: s.organizationId, branchId: branch.id }, include: encInclude });
  if (!e) throw notFound();
  return e as EncRow;
}

async function batchOf(tx: Tx, batchId: string): Promise<VitalsBatch | null> {
  const rows = await tx.observation.findMany({ where: { batchId }, orderBy: { code: "asc" } });
  const first = rows[0];
  if (!first) return null;
  const u = await tx.user.findFirst({ where: { id: first.recordedById }, select: { id: true, nameBn: true, nameEn: true, roles: { select: { role: true }, take: 1 } } });
  // The source is read from the batch's Provenance, never assumed (clinical review).
  const prov = await tx.provenance.findFirst({ where: { targetType: "Observation", targetId: batchId }, select: { source: true } });
  return {
    batchId, effectiveAt: first.effectiveAt.toISOString(), recordedAt: first.recordedAt.toISOString(),
    recordedBy: { id: first.recordedById, nameBn: u?.nameBn ?? "—", nameEn: u?.nameEn ?? "—", role: u?.roles[0]?.role ?? null },
    source: dash<VitalsBatch["source"]>(prov?.source ?? "patient_reported"),
    observations: rows.map((o) => ({ code: o.code, value: o.value, unit: o.unit, method: o.method, interpretation: o.interpretation })),
  };
}

export async function vitalsView(tx: Tx, s: SessionData, encounterId: string) {
  const e = await encounterHere(tx, s, encounterId);
  // "Current" = the most recently *measured* batch: an offline tablet syncing late must not hide a newer reading.
  const latest = await tx.observation.findFirst({ where: { encounterId: e.id, category: "vital-signs", status: { not: "entered_in_error" } }, orderBy: [{ effectiveAt: "desc" }, { recordedAt: "desc" }] });
  const current = latest ? await batchOf(tx, latest.batchId) : null;
  // The previous value per code from earlier visits anywhere in this tenant (DISTINCT ON keeps one row per code,
  // newest first). One patient record per tenant (decision 21); readings from another branch or facility are shown
  // read-only with that branch's name (decision of 02/10/2026, open question 45). Other tenants: never (RLS).
  const prev = await tx.observation.findMany({
    where: { patientId: e.patientId, category: "vital-signs", status: { not: "entered_in_error" }, encounterId: { not: e.id } },
    orderBy: [{ code: "asc" }, { effectiveAt: "desc" }], distinct: ["code"],
  });
  const branches = new Map((await tx.location.findMany({ where: { id: { in: [...new Set(prev.map((o) => o.branchId))] } }, select: { id: true, name: true, nameBn: true } })).map((b) => [b.id, b]));
  return {
    encounter: toVitalsEncounter(e), current,
    previous: prev.map((o) => ({
      code: o.code, value: o.value, unit: o.unit, effectiveAt: o.effectiveAt.toISOString(),
      branch: branches.get(o.branchId) ?? null, otherBranch: o.branchId !== e.branchId,
    })),
    /** for the view audit: which earlier batches were revealed */
    previousBatches: [...new Set(prev.map((o) => o.batchId))],
  };
}

export async function vitalsWorklist(tx: Tx, s: SessionData, now: Date) {
  const branch = await branchOf(tx, s);
  const day = dhakaDay(now);
  const rows = (await tx.encounter.findMany({ where: { organizationId: s.organizationId, branchId: branch.id, tokenDay: day, status: { in: ["arrived", "triaged"] } }, include: encInclude, orderBy: { tokenNo: "asc" } })) as EncRow[];
  const withVitals = new Set((await tx.observation.findMany({ where: { encounterId: { in: rows.map((r) => r.id) } }, select: { encounterId: true }, distinct: ["encounterId"] })).map((o) => o.encounterId));
  return { day, items: rows.map((e) => ({ ...toVitalsEncounter(e), hasVitals: withVitals.has(e.id) })) };
}

export async function recordVitals(tx: Tx, s: SessionData, encounterId: string, req: VitalsBatchRequest, now: Date) {
  const a = assessVitals(req.values);
  const unconfirmed = a.needsConfirm.filter((f) => !(req.confirmed ?? []).includes(f));
  if (!a.blocked && unconfirmed.length)
    throw err(400, "vitals_confirm", "মানটি আবার দেখে নিশ্চিত করুন (একক ঠিক আছে কি?)", "Re-check this value and confirm it (is the unit right?)",
      { field: unconfirmed[0], fields: unconfirmed.map((f) => ({ field: f, code: "confirm_required" })) });
  if (a.blocked) {
    const bad = a.fields.filter((f) => f.level === "impossible");
    if (!bad.length) throw err(400, "vitals_empty", "অন্তত একটি মান লিখুন", "Enter at least one value");
    throw err(400, "vitals_impossible", `${format.toBn(bad.length)}টি মান সম্ভব নয় — আবার মাপুন`, `${bad.length} value(s) not possible — re-measure`,
      { field: bad[0]!.field, fields: bad.map((f) => ({ field: f.field, code: f.code })) });
  }
  const effectiveAt = new Date(req.effectiveAt);
  if (effectiveAt.getTime() > now.getTime() + MAX_FUTURE_MS || effectiveAt.getTime() < now.getTime() - MAX_PAST_MS)
    throw err(400, "effective_at_range", "মাপার সময় ঠিক নেই — ডিভাইসের ঘড়ি দেখুন", "The measurement time is out of range — check the device clock", { field: "effectiveAt" });

  const e = await encounterHere(tx, s, encounterId);
  const from = dash<EncounterState>(e.status);
  // Vitals belong to an open visit. The first batch moves the token from waiting to "vitals done" (ENCOUNTER triage).
  if (from !== "arrived" && from !== "triaged" && from !== "in-progress")
    throw err(409, "encounter_closed", "এই ভিজিট বন্ধ — ভাইটাল যোগ করা যাবে না", "This visit is closed — vitals cannot be added");
  // Check-and-set on the visit's status in every case, so a visit closed at the same moment never takes vitals
  // (security review L4). Waiting → vitals done is the ENCOUNTER triage transition; otherwise the status stays.
  const to = from === "arrived" ? transition("encounter", ENCOUNTER, from, "triage") : from;
  const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status }, data: from === "arrived" ? { status: to as DbEncounterStatus, statusAt: now } : { status: e.status } });
  if (n.count !== 1) throw err(409, "stale", "অন্য কেউ আগেই বদলেছেন — আবার দেখুন", "Someone else changed this visit first — refresh");

  const batchId = `vb_${crypto.randomUUID()}`;
  const level = (f: VitalField) => a.fields.find((x) => x.field === f)?.interpretation ?? null;
  // Systolic and diastolic are flagged separately (clinical review: 150/80 must not store the 80 as High).
  const bp = req.values.bpSys !== undefined && req.values.bpDia !== undefined ? bpComponents(req.values.bpSys, req.values.bpDia) : null;
  const interpOf = (k: keyof typeof CODE) => (k === "bpSys" ? bp?.sys ?? null : k === "bpDia" ? bp?.dia ?? null : level(FIELD_OF[k]));
  const base = { tenantId: s.tenantId, organizationId: s.organizationId, branchId: e.branchId, patientId: e.patientId, encounterId: e.id, batchId, recordedById: s.userId, effectiveAt, deviceLabel: req.deviceLabel ?? null };
  type Row = typeof base & { code: string; unit: string; value: number; method: string | null; interpretation: ReturnType<typeof level> };
  const rows: Row[] = (Object.keys(CODE) as (keyof typeof CODE)[]).flatMap((k): Row[] => {
    const v = req.values[k];
    if (v === undefined) return [];
    const [code, unit] = CODE[k];
    return [{ ...base, code, unit, value: v, method: k === "rbs" ? (req.values.rbsMode ?? "random") : null, interpretation: interpOf(k) }];
  });
  if (a.bmi !== null) rows.push({ ...base, code: "bmi", unit: "kg/m2", value: a.bmi, method: "calculated", interpretation: null });
  await tx.observation.createMany({ data: rows });
  // Decision 47 / ADR 0007: a critical reading reaches the inbox of the visit's doctor (one item per critical value).
  if (e.practitionerId) {
    const crit = await tx.observation.findMany({ where: { batchId, interpretation: { in: ["HH", "LL"] } }, select: { id: true } });
    for (const o of crit) await deliverInApp(tx, s, { patientId: e.patientId, encounterId: e.id }, { kind: "critical-vital", channel: "doctor_inbox", recipientUserId: e.practitionerId, observationId: o.id }, now);
  }
  await tx.provenance.create({ data: {
    tenantId: s.tenantId, targetType: "Observation", targetId: batchId, activity: "record-vitals", agentId: s.userId, onBehalfOf: s.organizationId,
    source: "provider_verified", detail: { encounterId: e.id, role: s.role, deviceLabel: req.deviceLabel ?? null, outOfRange: a.outOfRange, critical: a.critical, confirmed: req.confirmed ?? [] } as object,
  } });
  const after = await encounterHere(tx, s, e.id);
  return { encounter: toVitalsEncounter(after), batch: (await batchOf(tx, batchId))!, assessment: a, from };
}
