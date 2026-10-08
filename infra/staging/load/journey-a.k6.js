// The 20-user journey-A load check on staging (week 2, session 2). Each virtual user runs one OPD visit after another
// over the API, as the E2E Test Clinic's staff (tenant t_e2e on staging, seeded with SEED_PASSWORD / SEED_PIN):
// front desk search → register + visit → queue → vitals → the doctor opens, writes (napa, an RBS order) and signs →
// cashier: bill from the orders, issue, cash payment, the bill read back → lab: labels, collect / receive / start,
// result, verify, validate (pathologist), release → the Rx printed (every 4th visit: PDF prints are capped at 30 a
// minute per user) → the queue again. Think time 1–3 s between steps, like a person at a screen.
// Run (grafana/k6 image), the password and PIN only in the environment:
//   docker run --rm -i -e BASE=https://setu.sociofitechnology.com -e PW -e PIN grafana/k6 run - < journey-a.k6.js
import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Trend } from "k6/metrics";

const BASE = (__ENV.BASE || "https://setu.sociofitechnology.com") + "/api";
const PW = __ENV.PW, PIN = __ENV.PIN;
const VUS = Number(__ENV.VUS || 20), HOLD = __ENV.HOLD || "5m";

export const options = {
  scenarios: { journeyA: { executor: "ramping-vus", startVUs: 0, stages: [{ duration: "30s", target: VUS }, { duration: HOLD, target: VUS }, { duration: "20s", target: 0 }], gracefulRampDown: "60s" } },
  // the target (ADR 0019 / session 2): p95 under 1 s for the queue and the bill
  // every other step is reported too (a threshold it cannot miss makes k6 keep its own timings)
  thresholds: Object.assign(
    Object.fromEntries(["search", "register", "vitals", "doctor-worklist", "consult-open", "consult-save", "consult-sign", "billing-worklist", "lab-worklist", "lab-labels", "lab-collect", "lab-receive", "lab-start", "lab-view", "lab-result", "lab-verify", "lab-validate", "lab-release", "rx-print"].map((k) => [`http_req_duration{step:${k}}`, ["p(95)<60000"]])),
    {
      "http_req_duration{step:queue}": ["p(95)<1000"],
      "http_req_duration{step:bill-make}": ["p(95)<1000"], "http_req_duration{step:bill-issue}": ["p(95)<1000"],
      "http_req_duration{step:bill-pay}": ["p(95)<1000"], "http_req_duration{step:bill-read}": ["p(95)<1000"],
      http_req_failed: ["rate<0.01"],
    }),
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
};
const visit = new Trend("visit_total_ms", true);

const USERS = { desk: "01799000001", doctor: "01799000002", doctor2: "01799000003", labTech: "01799000005", pathologist: "01799000006", cashier: "01799000008", cashier2: "01799000012" };

export function handleSummary(d) {
  const rows = Object.entries(d.metrics).filter(([k]) => k.startsWith("http_req_duration{step:")).map(([k, m]) => ({ step: k.slice(23, -1), n: m.values.count, med: m.values.med, p95: m.values["p(95)"], p99: m.values["p(99)"], max: m.values.max }));
  rows.sort((a, b) => b.p95 - a.p95);
  const f = (x) => String(Math.round(x)).padStart(6);
  const table = ["step                count    med    p95    p99    max (ms)", ...rows.map((r) => `${r.step.padEnd(18)} ${String(r.n).padStart(6)} ${f(r.med)} ${f(r.p95)} ${f(r.p99)} ${f(r.max)}`)].join("\n");
  const all = d.metrics.http_req_duration.values, failed = d.metrics.http_req_failed.values.rate;
  return { stdout: `\n${table}\n\nall requests: ${d.metrics.http_reqs.values.count}, p95 ${Math.round(all["p(95)"])} ms, failed ${(failed * 100).toFixed(2)}%; visits ${d.metrics.visit_total_ms?.values.count ?? 0}, a visit p95 ${Math.round(d.metrics.visit_total_ms?.values["p(95)"] ?? 0)} ms (incl. think time)\n`, "summary.json": JSON.stringify(d) };
}

export function setup() {
  if (!PW || !PIN) fail("set PW and PIN (the staging seed's SEED_PASSWORD / SEED_PIN)");
  const s = {};
  for (const [k, phone] of Object.entries(USERS)) {
    const r = http.post(`${BASE}/v1/auth/login`, JSON.stringify({ identifier: phone, password: PW }), { headers: { "content-type": "application/json" }, tags: { step: "login" } });
    if (r.status !== 200) fail(`login ${k}: ${r.status} ${r.body}`);
    s[k] = r.cookies.setu_session[0].value;
  }
  return s;
}

const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16); });
const think = () => sleep(1 + Math.random() * 2);
function req(method, path, who, step, body) {
  // a browser always asks for compression (k6 does not by default): the queue is ~130 KB raw, ~15 KB gzipped
  const params = { headers: { "content-type": "application/json", "accept-encoding": "gzip, br" }, cookies: { setu_session: { value: who, replace: true } }, tags: { step } };
  if (method !== "GET") params.headers["idempotency-key"] = uuid();
  const r = method === "GET" ? http.get(`${BASE}${path}`, params) : http.request(method, `${BASE}${path}`, body === undefined ? "{}" : JSON.stringify(body), params);
  if (!check(r, { [`${step} ok`]: (x) => x.status >= 200 && x.status < 300 })) { console.warn(`${step} ${method} ${path} → ${r.status} ${String(r.body).slice(0, 200)}`); return null; }
  return r.json();
}

export default function (s) {
  const t0 = Date.now();
  const doctor = __VU % 2 ? s.doctor : s.doctor2, cashier = __VU % 2 ? s.cashier : s.cashier2;
  // front desk
  req("GET", "/v1/patients/search?q=01711234567", s.desk, "search"); think();
  const phone = "019" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const reg = req("POST", "/v1/patients", s.desk, "register", { nameBn: "লোড পরীক্ষা রোগী", nameEn: `Load ${uuid().slice(0, 8)}`, sex: Math.random() < 0.5 ? "female" : "male", dobMode: "dob", dob: "03/03/1991", phone, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true });
  if (!reg) return;
  const enc = reg.encounter.id;
  req("GET", "/v1/queue", s.desk, "queue"); think();
  req("POST", `/v1/encounters/${enc}/vitals`, s.desk, "vitals", { values: { bpSys: 120, bpDia: 80, pulse: 78, temp: 98.6, spo2: 98 }, effectiveAt: new Date().toISOString() }); think();
  // the doctor
  req("GET", "/v1/consultations/worklist", doctor, "doctor-worklist");
  const open = req("POST", `/v1/encounters/${enc}/consultation/open`, doctor, "consult-open", {});
  if (!open) return;
  think();
  const saved = req("PUT", `/v1/compositions/${open.draft.id}`, doctor, "consult-save", { rev: open.draft.rev, sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" }, sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }], orders: [{ testCode: "rbs", priority: "routine" }] });
  if (!saved) return;
  const rev = saved.rev ?? saved.draft?.rev ?? saved.composition?.rev;
  const signed = req("POST", `/v1/compositions/${open.draft.id}/sign`, doctor, "consult-sign", { rev, pin: PIN, aiReviewed: false, uncodedAllergiesChecked: false });
  if (!signed) return;
  think();
  // the cashier
  req("GET", "/v1/billing/worklist", cashier, "billing-worklist");
  const made = req("POST", `/v1/encounters/${enc}/invoice`, cashier, "bill-make", {});
  if (!made) return;
  const inv = made.invoice;
  const issued = req("POST", `/v1/invoices/${inv.id}/issue`, cashier, "bill-issue", { rev: inv.rev });
  if (!issued) return;
  const total = (issued.invoice ?? issued).totalPaisa ?? inv.totalPaisa;
  req("POST", `/v1/invoices/${inv.id}/payments`, cashier, "bill-pay", { method: "cash", amountPaisa: total, tenderedPaisa: total });
  req("GET", `/v1/invoices/${inv.id}`, cashier, "bill-read"); think();
  // the lab (RBS)
  req("GET", "/v1/lab/worklist?stage=collect", s.labTech, "lab-worklist");
  const labels = req("POST", `/v1/lab/visits/${enc}/labels`, s.labTech, "lab-labels", {});
  if (labels) {
    for (const sp of labels.specimens ?? []) {
      if (sp.status !== "pending") continue;
      for (const stage of ["collect", "receive", "start"]) req("POST", `/v1/lab/specimens/${sp.id}/${stage}`, s.labTech, `lab-${stage}`, { at: new Date().toISOString() });
    }
    let v = req("GET", `/v1/lab/visits/${enc}`, s.labTech, "lab-view");
    const order = v && (v.orders ?? []).find((o) => o.testCode === "rbs");
    if (order) {
      req("POST", `/v1/lab/orders/${order.id}/results`, s.labTech, "lab-result", { entries: [{ analyteCode: "rbs", value: "5.6" }] });
      v = req("GET", `/v1/lab/visits/${enc}`, s.labTech, "lab-view");
      const obs = (x) => (x?.orders ?? []).flatMap((o) => o.results ?? o.observations ?? []);
      const prelim = obs(v).filter((o) => o.status === "preliminary").map((o) => o.id);
      if (prelim.length && req("POST", `/v1/lab/visits/${enc}/verify`, s.labTech, "lab-verify", { pin: PIN, observationIds: prelim, deltaChecked: true })) {
        v = req("GET", `/v1/lab/visits/${enc}`, s.pathologist, "lab-view");
        const verified = obs(v).filter((o) => prelim.includes(o.id)).map((o) => o.id);
        if (req("POST", `/v1/lab/visits/${enc}/validate`, s.pathologist, "lab-validate", { pin: PIN, observationIds: verified })) {
          v = req("GET", `/v1/lab/visits/${enc}`, s.pathologist, "lab-view");
          const rel = v?.release?.observationIds ?? verified;
          req("POST", `/v1/lab/visits/${enc}/release`, s.pathologist, "lab-release", { observationIds: rel });
        }
      }
    }
  }
  think();
  // the printed prescription (every 4th visit), the queue again
  if (Math.random() < 0.25) req("POST", `/v1/documents/rx/${open.draft.id}/print`, doctor, "rx-print", { format: "a5", lang: "both" });
  req("GET", "/v1/queue", s.desk, "queue");
  visit.add(Date.now() - t0);
  think();
}
