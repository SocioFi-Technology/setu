/* Shared by the ward contract tests (ADR 0015): sign in to the E2E Lite Hospital, make a ward of one's own, admit a
   fresh synthetic patient directly to it, and have the surgeon sign a round note with the given orders. */
import { randomInt, randomUUID } from "node:crypto";
import { expect } from "vitest";
/** ward names unique within a run (random suffixes collided: CI 06/10/2026, "bay taken") */
let wardSeq = 0;
import type { buildApp } from "../src/app.js";

export const T = "t_e2e_lite";
export const USERS = { desk: "01798000001", doctor: "01798000002", surgeon: "01798000005", nurse: "01798000004", nurse2: "01798000007", pharm: "01798000011", admin: "01798000010", cashier: "01798000008", owner: "01798000009", clinicNurse: "01722000004" } as const;
export type Who = keyof typeof USERS;
type App = Awaited<ReturnType<typeof buildApp>>;
export function client(app: App) {
  const cookies: Partial<Record<Who, string>> = {};
  const login = async () => {
    for (const [k, phone] of Object.entries(USERS)) {
      const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
      const c = r.headers["set-cookie"]; cookies[k as Who] = Array.isArray(c) ? c[0]! : (c as string);
    }
  };
  const get = (url: string, who: Who = "nurse") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
  const post = (url: string, payload: object = {}, who: Who = "nurse", key: string | null = randomUUID()) =>
    app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
  const put = (url: string, payload: object, who: Who = "surgeon") => app.inject({ method: "PUT", url, payload, headers: { cookie: cookies[who]!, "idempotency-key": randomUUID() } });
  return { login, get, post, put };
}
export const RUN = randomUUID().slice(0, 6);
/** Dhaka HH:MM `min` minutes from now (a slot that is due right away when min is small). */
export const dhakaHHMM = (min: number) => new Date(Date.now() + 6 * 3600_000 + min * 60_000).toISOString().slice(11, 16);
/** The slot instant for a Dhaka HH:MM today (or tomorrow when it has passed by more than 12 h). */
export function slotAt(hhmm: string): string {
  const day = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  let t = new Date(new Date(`${day}T${hhmm}:00Z`).getTime() - 6 * 3600_000);
  if (t.getTime() < Date.now() - 12 * 3600_000) t = new Date(t.getTime() + 864e5);
  return t.toISOString();
}
export const TICKS = { patient: true, drug: true, dose: true, route: true, time: true };

export async function setup(c: ReturnType<typeof client>) {
  /** a ward of its own (General), so runs never share beds or ward stock */
  async function ownWard(n = 2, bedClass = "General") {
    const name = `WW${RUN}${++wardSeq}`;
    const r = await c.post("/v1/admin/wards", { name, beds: n, bedClass }, "admin");
    expect(r.statusCode, r.body).toBe(201);
    return name;
  }
  async function newPatient() {
    const r = await c.post("/v1/patients", { nameBn: "ওয়ার্ড রোগী", nameEn: `Ward Patient ${RUN}-${randomInt(1e5)}`, sex: "male", dobMode: "dob", dob: "20/01/1969", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false }, "desk");
    expect(r.statusCode, r.body).toBe(201);
    return r.json().patient.id as string;
  }
  /** a direct admission to the first bed of `ward` under the surgeon */
  async function admit(wardName: string, bedIndex = 0) {
    const beds = (await c.get("/v1/ipd/beds", "nurse")).json().wards.find((w: { name: string }) => w.name === wardName).beds;
    const patientId = await newPatient();
    const r = await c.post("/v1/ipd/admissions", { patientId, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "Post-op wound infection", bedClass: "General", bedId: beds[bedIndex].id, guardian: { name: "রাশেদা ইসলাম", relationship: "wife", phone: "01811223355" }, consents: ["general", "financial", "guardian-id"] }, "desk");
    expect(r.statusCode, r.body).toBe(201);
    return { patientId, encounterId: r.json().encounter.id as string, admissionId: r.json().id as string, wardId: beds[bedIndex].ward.id as string, bedId: beds[bedIndex].id as string };
  }
  /** the surgeon opens a round note, writes these lines and signs it (PIN 1234); returns the round view */
  async function signRound(encounterId: string, lines: object[], sections = { s: "", o: "", a: "Wound infection", p: "IV antibiotics" }) {
    const open = await c.post(`/v1/ipd/encounters/${encounterId}/round/open`, {}, "surgeon");
    expect(open.statusCode, open.body).toBe(200);
    const draft = open.json().draft;
    const saved = await c.put(`/v1/ipd/round-notes/${draft.id}`, { rev: draft.rev, sections, lines, orders: [] });
    expect(saved.statusCode, saved.body).toBe(200);
    const signed = await c.post(`/v1/ipd/round-notes/${draft.id}/sign`, { rev: saved.json().draft.rev, pin: "1234" }, "surgeon");
    expect(signed.statusCode, signed.body).toBe(200);
    return signed.json();
  }
  return { ownWard, newPatient, admit, signRound };
}
export const line = (medicineKey: string, o: Partial<{ route: string; doseText: string; doseQty: number | null; times: string[]; prn: boolean; prnMaxPer24h: number | null }> = {}) =>
  ({ medicineKey, route: "iv", doseText: "1 dose", doseQty: 1, times: [dhakaHHMM(2)], prn: false, prnMaxPer24h: null, ...o });

/* ADR 0016: a given dose carries its scans. The wristband from the print endpoint (cached per visit) and, from ward
   stock, the label of a ward batch of the order's medicine with stock — what a nurse would scan at the bedside. */
const bands = new Map<string, string>();
export async function bandOf(c: ReturnType<typeof client>, encounterId: string): Promise<string> {
  const hit = bands.get(encounterId);
  if (hit) return hit;
  const r = await c.post(`/v1/nursing/encounters/${encounterId}/wristband`, { reason: "test: band for the dose" });
  expect(r.statusCode, r.body).toBe(201);
  bands.set(encounterId, r.json().code);
  return r.json().code as string;
}
export async function labelOf(c: ReturnType<typeof client>, encounterId: string, requestId: string): Promise<string | undefined> {
  const { forTenant } = await import("@setu/db");
  return forTenant(T, async (tx) => {
    const o = await tx.medicationRequest.findFirst({ where: { id: requestId } });
    const live = await tx.bedAssignment.findFirst({ where: { encounterId, status: "occupied" }, include: { bed: true } });
    if (!o || !live?.bed.parentId) return undefined;
    // a batch with stock first; an opened multi-dose vial's batch may be at 0 and its label is still on the vial
    const b = (await tx.stockBatch.findFirst({ where: { location: `ward:${live.bed.parentId}`, medicineKey: o.medicineKey, qtyOnHand: { gt: 0 } }, orderBy: { expiry: "asc" } }))
      ?? (await tx.stockBatch.findFirst({ where: { location: `ward:${live.bed.parentId}`, medicineKey: o.medicineKey }, orderBy: { expiry: "asc" } }));
    return b?.id;
  }).then(async (id) => {
    if (!id) return undefined;
    // the label a nurse would print for that batch (its digit-only code; made on first print)
    const r = await c.post("/v1/nursing/labels", { batchIds: [id] });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().items[0].code as string;
  });
}
/** Adds the bedside scans to a given dose that has none (`scan: {}` sends none on purpose). */
export async function withScans(c: ReturnType<typeof client>, encounterId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (body.outcome !== "given" || body.scan !== undefined) return body;
  const band = await bandOf(c, encounterId);
  const med = (body.source ?? "ward-stock") === "ward-stock" ? await labelOf(c, encounterId, body.requestId as string) : undefined;
  return { ...body, scan: { band, ...(med ? { med } : {}) } };
}
