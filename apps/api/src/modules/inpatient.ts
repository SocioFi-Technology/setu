/* Shared by the ward modules (ADR 0015): an inpatient at this facility (encounter of class ipd with its admitted
   Admission), their bed and ward, names, the NEWS2 of a stored batch, and the inpatient orders' facts. */
import type { Tx } from "@setu/db";
import { consciousnessOf, news2, nextObsMinutes, type News2Input } from "@setu/domain";
import type { News2 } from "@setu/contracts";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { notFound } from "./frontdesk.js";

export type Enc = NonNullable<Awaited<ReturnType<Tx["encounter"]["findFirst"]>>> & { patient: NonNullable<Awaited<ReturnType<Tx["patient"]["findFirst"]>>> };
export type Loc = NonNullable<Awaited<ReturnType<Tx["location"]["findFirst"]>>>;
export type Adm = NonNullable<Awaited<ReturnType<Tx["admission"]["findFirst"]>>>;
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
export const stale = () => err(409, "stale", "অন্য কেউ আগেই বদলেছেন — আবার দেখুন", "Someone else changed this first — refresh");
export const closedVisit = () => err(409, "encounter_closed", "এই ভর্তি আর খোলা নেই", "This admission is no longer open");

export interface Inpatient { e: Enc; adm: Adm; bed: Loc | null; ward: Loc | null; open: boolean }
/** An inpatient visit at the session's facility (404 otherwise, another tenant's included). */
export async function inpatientHere(tx: Tx, s: SessionData, encounterId: string): Promise<Inpatient> {
  const e = (await tx.encounter.findFirst({ where: { id: encounterId, class: "ipd", organizationId: s.organizationId }, include: { patient: true } })) as Enc | null;
  if (!e) throw notFound();
  const adm = await tx.admission.findFirst({ where: { encounterId: e.id, status: "admitted" } });
  if (!adm) throw notFound();
  const live = await tx.bedAssignment.findFirst({ where: { encounterId: e.id, status: "occupied" } });
  const bed = live ? await tx.location.findFirst({ where: { id: live.bedId } }) : null;
  const ward = bed?.parentId ? await tx.location.findFirst({ where: { id: bed.parentId } }) : null;
  return { e, adm, bed, ward, open: e.status === "in_progress" };
}
export const dayOfStay = (admittedAt: Date | null, now: Date) => (admittedAt ? Math.floor((now.getTime() - admittedAt.getTime()) / 864e5) + 1 : 1);
export async function peopleOf(tx: Tx, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = want.length ? await tx.user.findMany({ where: { id: { in: want } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((u) => [u.id, u]));
  return (id: string | null | undefined) => (id && m.get(id)) || { id: id ?? "", nameBn: "—", nameEn: "—" };
}
export const erPatientOf = (p: Enc["patient"]) => ({
  id: p.id, facilityNo: p.facilityNo, nameBn: p.nameBn, nameEn: p.nameEn, sex: p.sex, birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
  approxAgeYears: p.approxAgeYears, approxAgeMonths: p.approxAgeMonths, approxAgeAt: iso(p.approxAgeAt), identityConfidence: dash<"verified">(p.identityConfidence),
});

/* ───── NEWS2 of a stored batch ───── */
type Obs = { code: string; value: number; effectiveAt: Date; batchId: string };
export const NEWS2_CODES = ["respiratory-rate", "spo2", "supplemental-oxygen", "bp-systolic", "pulse", "consciousness", "body-temperature", "news2"];
export function news2OfBatch(rows: Obs[]): News2 | null {
  const v = Object.fromEntries(rows.map((r) => [r.code, r.value]));
  if (v["news2"] === undefined) return null;
  const input: News2Input = {
    rr: v["respiratory-rate"], spo2: v["spo2"], onOxygen: v["supplemental-oxygen"] === 1, sbp: v["bp-systolic"], pulse: v["pulse"],
    consciousness: v["consciousness"] !== undefined ? consciousnessOf(v["consciousness"]) ?? undefined : undefined, tempF: v["body-temperature"],
  };
  const r = news2(input);
  return { total: r.total, red: r.red, complete: r.complete, risk: r.risk, parts: r.parts as Record<string, number>, missing: r.missing, at: rows[0]!.effectiveAt.toISOString() };
}
/** The latest NEWS2 batch of each visit, and when the next set is due. */
export async function latestNews2(tx: Tx, encounterIds: string[]): Promise<Map<string, { news2: News2; nextObsDueAt: string }>> {
  const out = new Map<string, { news2: News2; nextObsDueAt: string }>();
  if (!encounterIds.length) return out;
  const scores = await tx.observation.findMany({ where: { encounterId: { in: encounterIds }, code: "news2", status: { not: "entered_in_error" } }, orderBy: [{ effectiveAt: "desc" }, { recordedAt: "desc" }], select: { encounterId: true, batchId: true } });
  const latest = new Map<string, string>();
  for (const sc of scores) if (!latest.has(sc.encounterId)) latest.set(sc.encounterId, sc.batchId);
  const rows = latest.size ? await tx.observation.findMany({ where: { batchId: { in: [...latest.values()] } }, select: { code: true, value: true, effectiveAt: true, batchId: true, encounterId: true } }) : [];
  for (const [enc, batch] of latest) {
    const n = news2OfBatch(rows.filter((r) => r.batchId === batch));
    if (n) out.set(enc, { news2: n, nextObsDueAt: new Date(new Date(n.at).getTime() + nextObsMinutes(n) * 60_000).toISOString() });
  }
  return out;
}
