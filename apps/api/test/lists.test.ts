/* Staging load check (ADR 0019): the queue, the doctor's worklist and the billing worklist carry every visit still in
   play, but only the RECENT_DONE most recent closed ones (done / no-show, a doctor's seen visits, settled bills) unless
   ?all=1 — with the full counts either way. E2E Test Clinic (t_e2e); everything made here is removed again. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECENT_DONE } from "@setu/contracts";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const made: string[] = [];
let patientId = "";

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of [["desk", "01799000001"], ["doctor", "01799000002"], ["cashier", "01799000008"]] as const) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
});
afterAll(async () => {
  if (db && made.length) await db.forTenant("t_e2e", (tx) => tx.encounter.deleteMany({ where: { id: { in: made } } }));
  await app.close();
});

const get = (url: string, who = "desk") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object, who = "desk") => app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, "idempotency-key": randomUUID() } });
const form = () => ({ nameBn: "তালিকা পরীক্ষা", nameEn: `List Test ${RUN}`, sex: "female", dobMode: "dob", dob: "01/01/1990", phone: `015${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur" });
type Col = { key: string; items: { id: string }[]; total: number };

describe.runIf(db)("lists carry what is in play, and the latest closed ones (ADR 0019 load check)", () => {
  it("queue: more than RECENT_DONE no-shows → that column carries the latest RECENT_DONE, the newest included; ?all=1 carries them all; active columns are complete", async () => {
    let last = "";
    for (let i = 0; i <= RECENT_DONE; i++) {
      const v = (await post("/v1/patients", { ...form(), createVisit: true })).json().encounter;
      expect((await post(`/v1/encounters/${v.id}/actions`, { action: "noShow" })).statusCode).toBe(200);
      made.push(v.id); last = v.id;
    }
    const q = (await get("/v1/queue")).json() as { columns: Col[] };
    const noShow = q.columns.find((c) => c.key === "noShow")!;
    expect(noShow.total).toBeGreaterThan(RECENT_DONE);
    expect(noShow.items).toHaveLength(RECENT_DONE);
    expect(noShow.items.map((i) => i.id)).toContain(last);
    for (const c of q.columns.filter((x) => ["waiting", "vitals", "withDoctor"].includes(x.key))) expect(c.items).toHaveLength(c.total);
    for (const c of q.columns) expect(c.items.length).toBeLessThanOrEqual(c.total);
    const all = (await get("/v1/queue?all=1")).json() as { columns: Col[] };
    const noShowAll = all.columns.find((c) => c.key === "noShow")!;
    expect(noShowAll.items).toHaveLength(noShowAll.total);
    expect(noShowAll.total).toBe(noShow.total);
  }, 60_000);

  it("doctor's worklist: more than RECENT_DONE seen visits → the latest RECENT_DONE and doneTotal; ?all=1 carries them all", async () => {
    const v = (await post("/v1/patients", { ...form(), createVisit: true })).json();
    patientId = v.patient.id; made.push(v.encounter.id);
    const base = await db!.forTenant("t_e2e", (tx) => tx.encounter.findFirstOrThrow({ where: { id: v.encounter.id } }));
    const now = Date.now();
    for (let i = 0; i <= RECENT_DONE; i++) {
      const e = await db!.forTenant("t_e2e", (tx) => tx.encounter.create({ data: {
        tenantId: "t_e2e", organizationId: base.organizationId, branchId: base.branchId, patientId, class: "opd", status: "finished",
        token: `Z-${RUN}${i}`, tokenNo: 700000 + randomInt(0, 99999), tokenDay: base.tokenDay, createdById: "u_e2e_desk",
        practitionerId: "u_e2e_doctor", arrivedAt: new Date(now - 3_600_000), statusAt: new Date(now - (RECENT_DONE - i) * 1000),
      } }));
      made.push(e.id);
    }
    const w = (await get("/v1/consultations/worklist", "doctor")).json() as { doneTotal: number; items: { id: string; status: string }[] };
    const seen = w.items.filter((i) => i.status === "finished");
    expect(w.doneTotal).toBeGreaterThan(RECENT_DONE);
    expect(seen).toHaveLength(RECENT_DONE);
    expect(seen.map((i) => i.id)).toContain(made[made.length - 1]); // the most recently finished
    const all = (await get("/v1/consultations/worklist?all=1", "doctor")).json() as { doneTotal: number; items: { status: string }[] };
    expect(all.items.filter((i) => i.status === "finished")).toHaveLength(all.doneTotal);
  }, 60_000);

  it("billing worklist: every unsettled visit, at most RECENT_DONE settled ones, settledTotal; ?all=1 carries them all", async () => {
    const settled = (w: { items: { invoice: { status: string } | null }[] }) => w.items.filter((i) => ["balanced", "cancelled"].includes(i.invoice?.status ?? "")).length;
    const w = (await get("/v1/billing/worklist", "cashier")).json();
    expect(settled(w)).toBe(Math.min(w.settledTotal, RECENT_DONE));
    const all = (await get("/v1/billing/worklist?all=1", "cashier")).json();
    expect(settled(all)).toBe(all.settledTotal);
    expect(all.items.length - settled(all)).toBe(w.items.length - settled(w)); // the unsettled ones: the same, in full
  });
});
