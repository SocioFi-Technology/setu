/* Demo tenant used by dev, e2e and the journeys: Green Life Clinic, Mirpur (the prototype's sample facility).
   Sample people match the walkthrough so Playwright specs read like the journey text. */
import { createHash } from "node:crypto";
import { ANALYTES_SAMPLE, ICD11_SAMPLE, MEDICINES_SAMPLE, MRP_SAMPLE, RANGES_SAMPLE, TESTS_SAMPLE, emptySections, labFlag, patientAgeYears, priceListSample, rangeFor, rxQuantity } from "@setu/domain";
import { owner as prisma } from "./owner.ts";
import { SEED_BED_STATES, SEED_WARDS } from "./wards.ts";

const hash = (s: string) => createHash("sha256").update("dev-only:" + s).digest("hex"); // replaced by argon2 in the auth slice
/** ADR 0010: the demo facilities were set up before go-live existed — live, A5 formats, every payment method. */
const LIVE = { status: "live" as const, liveAt: new Date("2026-10-01T00:00:00Z"), receiptFormat: "a5", rxFormat: "a5", paymentMethods: ["cash", "card", "bank", "bkash", "nagad"] };

/* Slice A5: the sample catalogues from @setu/domain catalog.ts (labelled sample / unverified — never invented). */
async function seedCatalogues(tenantId: string) {
  for (const c of ICD11_SAMPLE) {
    const data = { bn: c.bn, en: c.en, aliases: c.aliases, verification: c.verification };
    await prisma.icd11Code.upsert({ where: { tenantId_code: { tenantId, code: c.code } }, update: data, create: { tenantId, code: c.code, ...data } });
  }
  for (const m of MEDICINES_SAMPLE) {
    const data = { brand: m.brand, brandBn: m.brandBn, generic: m.generic, strength: m.strength, form: m.form, manufacturer: m.manufacturer, ingredients: m.ingredients, classes: m.classes, defaultDose: m.defaults.dose, defaultMeal: m.defaults.meal, defaultDays: m.defaults.days, sample: true };
    await prisma.medicine.upsert({ where: { tenantId_key: { tenantId, key: m.id } }, update: data, create: { tenantId, key: m.id, ...data } });
  }
  for (const t of TESTS_SAMPLE) {
    const data = { nameEn: t.nameEn, nameBn: t.nameBn, group: t.group };
    await prisma.orderableTest.upsert({ where: { tenantId_code: { tenantId, code: t.code } }, update: data, create: { tenantId, code: t.code, ...data } });
  }
}

/* Pharmacy (ADR 0009): sample batches per facility, marked sample, filled through receive moves (the only way stock
   arrives). Every medicine has a counter batch and a store batch; Comet also an expired batch (blocked) and one near
   expiry (FEFO takes it first); Napa only an expired batch, so it is out of stock (journey P2 substitutes Ace). */
export async function seedStock(tenantId: string, organizationId: string, byId: string, now = new Date()) {
  const day = (n: number) => new Date(now.getTime() + 6 * 3600_000 + n * 864e5).toISOString().slice(0, 10);
  const plan: [string, string, number, number, string][] = [];
  for (const m of MEDICINES_SAMPLE) {
    if (m.id === "napa") { plan.push([m.id, "NP2504", -20, 100, "counter"]); continue; }
    plan.push([m.id, `${m.id.slice(0, 2).toUpperCase()}2601`, 200, 300, "counter"], [m.id, `${m.id.slice(0, 2).toUpperCase()}2604`, 500, 500, "store"]);
    if (m.id === "comet") plan.push([m.id, "CM2511", 60, 60, "counter"], [m.id, "CM2508", -5, 40, "counter"]);
  }
  for (const [key, batchNo, expiresIn, qty, location] of plan) {
    const mrp = MRP_SAMPLE[key] ?? 500;
    const where = { tenantId_organizationId_medicineKey_batchNo_location: { tenantId, organizationId, medicineKey: key, batchNo, location } };
    if (await prisma.stockBatch.findUnique({ where })) continue;
    const b = await prisma.stockBatch.create({ data: { tenantId, organizationId, medicineKey: key, batchNo, expiry: day(expiresIn), location, costPaisa: Math.round(mrp * 0.85), mrpPaisa: mrp, vatRateBp: 0, sample: true } });
    await prisma.stockMove.create({ data: { tenantId, organizationId, batchId: b.id, kind: "receive", qty, refType: "seed", reason: "sample opening stock", byId } });
  }
}

/* ADR 0014: wards and beds like the admin masters make them (a ward under the branch, beds with a class, vacant),
   for the Hospital Lite demo and the E2E Lite hospital: an ER ward of bays, a general ward, cabins and an HDU.
   Walkthrough B3 wants a bed being cleaned and a blocked one on the picker; a re-seed keeps the states a run left. */
export async function seedWards(tenantId: string, organizationId: string, branchId: string, idPrefix: string, only?: string[]) {
  for (const [key, name, nameBn, bedClass, n, bedName] of SEED_WARDS) {
    if (only && !only.includes(key)) continue;
    const wid = `${idPrefix}l_ward_${key}`;
    await prisma.location.upsert({ where: { id: wid }, update: {}, create: { id: wid, tenantId, organizationId, parentId: branchId, kind: "ward", name, nameBn } });
    for (let i = 0; i < n; i++) {
      const bid = `${idPrefix}l_bed_${key}_${i + 1}`;
      const st = SEED_BED_STATES[bedName(i)] ?? { bedState: "vacant" as const, bedNote: null };
      await prisma.location.upsert({ where: { id: bid }, update: {}, create: { id: bid, tenantId, organizationId, parentId: wid, kind: "bed", name: bedName(i), bedClass, ...st } });
    }
  }
}

/* Slice A8–A11: the sample analyte list and adult reference ranges (@setu/domain lab.ts, pending clinician sign-off,
   decision D1). Upsert, so a re-seed refreshes the sample rows. */
async function seedLabCatalogues(tenantId: string) {
  for (const a of ANALYTES_SAMPLE) {
    const data = { testCode: a.testCode, nameEn: a.nameEn, nameBn: a.nameBn, unit: a.unit, decimals: a.decimals, critLow: a.critLow, critHigh: a.critHigh, deltaCheck: a.deltaCheck, position: a.position, sample: true, active: true };
    await prisma.labAnalyte.upsert({ where: { tenantId_code: { tenantId, code: a.code } }, update: data, create: { tenantId, code: a.code, ...data } });
  }
  for (const r of RANGES_SAMPLE) {
    const id = `${tenantId}_rr_${r.analyteCode}_${r.sex ?? "any"}_${r.ageMinYears}`;
    const data = { analyteCode: r.analyteCode, sex: r.sex, ageMinYears: r.ageMinYears, ageMaxYears: r.ageMaxYears, low: r.low, high: r.high, label: r.label, sample: true };
    await prisma.labReferenceRange.upsert({ where: { id }, update: data, create: { id, tenantId, ...data } });
  }
}

/* Walkthrough A9: Rahima Khatun's validated results from her 12/08/2026 visit (the prototype's "Prev" column), so the
   delta check has something to compare with. Synthetic. Seeded without an order or report (the 12/08 note was seeded
   before the lab existed and a signed note takes no new orders); they go through the same RESULT steps as the API —
   entered by the lab technologist, verified by them, validated by the pathologist. */
async function seedLabHistory(tenantId: string, organizationId: string, branchId: string, idPrefix: string, techId: string, pathId: string) {
  const patientId = `${idPrefix}p_rahima`, encounterId = `${idPrefix}enc_rahima_20260812`, at = new Date("2026-08-12T05:30:00Z");
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) return;
  const ageYears = patientAgeYears({ birthDate: patient.birthDate?.toISOString().slice(0, 10) ?? null, approxAgeYears: patient.approxAgeYears, approxAgeAt: patient.approxAgeAt?.toISOString() ?? null }, at);
  const sex = patient.sex === "other" ? "other" : patient.sex;
  const PREV: Record<string, number> = { hb: 12.1, wbc: 8200, plt: 260000, rbs: 9.8, na: 137, k: 4.6, cl: 102, hba1c: 8.4, creat: 0.9 };
  for (const a of ANALYTES_SAMPLE) {
    const value = PREV[a.code];
    if (value === undefined) continue;
    const id = `${idPrefix}lab_rahima_20260812_${a.code}`;
    if (await prisma.observation.findUnique({ where: { id } })) continue;
    const range = rangeFor(RANGES_SAMPLE, a.code, { sex, ageYears });
    await prisma.observation.create({ data: {
      id, tenantId, organizationId, branchId, patientId, encounterId, batchId: `${idPrefix}lb_rahima_20260812`, category: "laboratory", code: a.code, value, unit: a.unit,
      method: "manual", interpretation: labFlag(value, range, a), status: "preliminary", recordedById: techId, effectiveAt: at, recordedAt: at,
      refLow: range?.low ?? null, refHigh: range?.high ?? null, refLabel: range?.label ?? null, critLow: a.critLow, critHigh: a.critHigh, statusAt: at,
    } });
    await prisma.observation.update({ where: { id }, data: { status: "verified", verifiedById: techId, verifiedAt: at, statusAt: at } });
    await prisma.observation.update({ where: { id }, data: { status: "final", validatedById: pathId, validatedAt: at, statusAt: at } });
  }
  if (!(await prisma.provenance.count({ where: { targetType: "Observation", targetId: `${idPrefix}lb_rahima_20260812` } })))
    await prisma.provenance.create({ data: { tenantId, targetType: "Observation", targetId: `${idPrefix}lb_rahima_20260812`, activity: "lab-validate", agentId: pathId, onBehalfOf: organizationId, source: "provider_verified", recorded: at, detail: { seeded: true, verifiedBy: techId } } });
}

/* Slice A6: the prototype's sample price list for one facility (every row `sample`), with a consultation fee for each of
   its doctors. Upsert by code, so a re-seed refreshes names and prices of the sample rows only. */
async function seedPriceList(tenantId: string, organizationId: string) {
  const roles = await prisma.practitionerRole.findMany({ where: { tenantId, organizationId, role: "doctor" }, include: { user: true }, orderBy: { userId: "asc" } });
  for (const e of priceListSample(roles.map((r) => ({ id: r.userId, nameEn: r.user.nameEn, nameBn: r.user.nameBn })))) {
    const data = { kind: e.kind, refCode: e.refCode, nameEn: e.nameEn, nameBn: e.nameBn, unitPaisa: e.unitPaisa, vatRateBp: e.vatRateBp, sample: true, active: true };
    await prisma.chargeItemDefinition.upsert({ where: { tenantId_organizationId_code: { tenantId, organizationId, code: e.code } }, update: data, create: { tenantId, organizationId, code: e.code, ...data } });
  }
}

/* Walkthrough A5: Rahima Khatun's allergies (Penicillin — rash, recorded 12/08/2026; Sulfa) and the signed note of her
   12/08/2026 visit (diagnoses 5A11, BA00; Comet, Seclo, Amdocal — the prototype's "current medicines"). Synthetic. The
   note is written as a draft with its items and then signed by the seeded doctor, the same order the API uses. */
async function seedLastNote(tenantId: string, organizationId: string, branchId: string, idPrefix: string, doctorId: string) {
  const patientId = `${idPrefix}p_rahima`, encounterId = `${idPrefix}enc_rahima_20260812`, at = new Date("2026-08-12T05:05:00Z");
  for (const [id, key, labelBn, labelEn, reaction, severity] of [
    [`${idPrefix}al_rahima_pen`, "penicillin", "পেনিসিলিন", "Penicillin", "rash", "moderate"],
    [`${idPrefix}al_rahima_sulfa`, "sulfonamide", "সালফা", "Sulfa drugs", null, "unknown"],
  ] as const) {
    await prisma.allergyIntolerance.upsert({ where: { id }, update: {}, create: { id, tenantId, organizationId, patientId, encounterId, kind: "class", key, labelBn, labelEn, reaction, severity, recordedById: doctorId, recordedAt: at } });
    if (!(await prisma.provenance.count({ where: { targetType: "AllergyIntolerance", targetId: id } })))
      await prisma.provenance.create({ data: { tenantId, targetType: "AllergyIntolerance", targetId: id, activity: "record-allergy", agentId: doctorId, onBehalfOf: organizationId, source: "provider_verified", recorded: at, detail: { seeded: true } } });
  }
  const id = `${idPrefix}cmp_rahima_20260812`;
  if (await prisma.composition.findUnique({ where: { id } })) return;
  const sections = { ...emptySections(), complaints: [{ text: "Follow-up: diabetes and blood pressure", duration: null }], advice: "Continue medicines; diet and walking." };
  await prisma.composition.create({ data: { id, tenantId, organizationId, branchId, patientId, encounterId, version: 1, status: "draft", sections: sections as object, sectionSources: {}, authorId: doctorId, createdAt: at } });
  for (const [i, [code, verificationStatus]] of ([["5A11", "confirmed"], ["BA00", "confirmed"]] as const).entries()) {
    const c = ICD11_SAMPLE.find((x) => x.code === code)!;
    await prisma.condition.create({ data: { tenantId, patientId, encounterId, compositionId: id, position: i, code, codeVerification: c.verification, labelBn: c.bn, labelEn: c.en, verificationStatus } });
  }
  for (const [i, [key, dose, meal, days]] of ([["comet", "1+0+1", "after", 30], ["seclo", "1+0+0", "before", 30], ["amdocal", "0+0+1", "after", 30]] as const).entries()) {
    const m = MEDICINES_SAMPLE.find((x) => x.id === key)!;
    await prisma.medicationRequest.create({ data: { tenantId, patientId, encounterId, compositionId: id, position: i, medicineKey: key, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes, dose, meal, days, quantity: rxQuantity(dose, days) } });
  }
  await prisma.composition.update({ where: { id }, data: { status: "final", signedAt: at, signedById: doctorId } });
  await prisma.provenance.create({ data: { tenantId, targetType: "Composition", targetId: id, activity: "sign", agentId: doctorId, onBehalfOf: organizationId, source: "provider_verified", recorded: at, detail: { seeded: true, version: 1 } } });
}

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { id: "t_greenlife" },
    update: { patientNoPrefix: "GLC" },
    create: { id: "t_greenlife", name: "Green Life Clinic", plan: "pro", patientNoPrefix: "GLC" },
  });
  const org = await prisma.organization.upsert({
    where: { id: "o_greenlife_mirpur" },
    update: {},
    create: { id: "o_greenlife_mirpur", tenantId: tenant.id, name: "Green Life Clinic, Mirpur", nameBn: "গ্রিন লাইফ ক্লিনিক, মিরপুর", address: "Mirpur, Dhaka", ...LIVE },
  });
  const ward = await prisma.location.upsert({
    where: { id: "l_ward2a" }, update: {},
    create: { id: "l_ward2a", tenantId: tenant.id, organizationId: org.id, kind: "ward", name: "Ward 2A", nameBn: "ওয়ার্ড ২এ" },
  });
  for (const n of ["01", "02", "03", "04", "05"]) {
    await prisma.location.upsert({
      where: { id: `l_bed_2a_${n}` }, update: {},
      create: { id: `l_bed_2a_${n}`, tenantId: tenant.id, organizationId: org.id, parentId: ward.id, kind: "bed", name: `2A-${n}`, bedClass: "General", bedState: "vacant" },
    });
  }
  const users: [string, string, string, string, "receptionist" | "doctor" | "nurse" | "labTech" | "pathologist" | "pharmacist" | "cashier" | "owner" | "admin"][] = [
    ["u_sadia", "সাদিয়া রহমান", "Sadia Rahman", "01711000001", "receptionist"],
    ["u_imran", "ডা. ইমরান কবির", "Dr. Imran Kabir", "01711000002", "doctor"],
    ["u_selina", "ডা. সেলিনা পারভীন", "Dr. Selina Parveen", "01711000003", "doctor"],
    ["u_shirin", "শিরিন আক্তার", "Shirin Akter", "01711000004", "nurse"],
    ["u_tanvir", "তানভীর হাসান", "Tanvir Hasan", "01711000005", "labTech"],
    ["u_kanta", "ডা. কান্তা পারভীন", "Dr. Kanta Parveen", "01711000006", "pathologist"],
    ["u_jewel", "মো. জুয়েল রানা", "Md. Jewel Rana", "01711000007", "pharmacist"],
    ["u_kafia", "কাফিয়া মিয়া", "Kafia Mia", "01711000008", "cashier"],
    ["u_anwar", "আনোয়ার হোসেন", "Anwar Hossain", "01711000009", "owner"],
    ["u_admin", "অ্যাডমিন", "Admin", "01711000010", "admin"],
  ];
  for (const [id, nameBn, nameEn, phone, role] of users) {
    const u = await prisma.user.upsert({
      where: { id }, update: {},
      create: { id, tenantId: tenant.id, nameBn, nameEn, phone, passwordHash: hash("setu1234"), pinHash: hash("1234") },
    });
    await prisma.practitionerRole.upsert({
      where: { userId_organizationId_role: { userId: u.id, organizationId: org.id, role } }, update: {},
      create: { tenantId: tenant.id, userId: u.id, organizationId: org.id, role },
    });
  }
  /* Branch: tokens are numbered per branch per day. */
  await prisma.location.upsert({ where: { id: "l_branch_mirpur" }, update: {}, create: { id: "l_branch_mirpur", tenantId: tenant.id, organizationId: org.id, kind: "branch", name: "Mirpur branch", nameBn: "মিরপুর শাখা" } });

  /* Walkthrough A1: five people share +880 1711-234567 (Abdul Karim owns it); Rahima Begum is a possible duplicate of
     Rahima Khatun. Phones are stored as 10 digits after +880. Synthetic people only; no national ID numbers. */
  type P = { id: string; no: string; bn: string; en: string; sex: "male" | "female"; dob?: string; approx?: number; phone: string; owner: string; upazila: string; conf: "verified" | "unverified" | "possible_duplicate"; guardian?: [string, string, string] };
  const patients: P[] = [
    { id: "p_rahima", no: "GLC-240117", bn: "রহিমা খাতুন", en: "Rahima Khatun", sex: "female", dob: "1984-03-15", phone: "1711234567", owner: "family", upazila: "Mirpur", conf: "verified", guardian: ["husband", "আব্দুল করিম", "1711234567"] },
    { id: "p_karim", no: "GLC-220311", bn: "আব্দুল করিম", en: "Abdul Karim", sex: "male", dob: "1979-02-02", phone: "1711234567", owner: "self", upazila: "Mirpur", conf: "verified" },
    { id: "p_sumaiya", no: "GLC-250044", bn: "সুমাইয়া আক্তার", en: "Sumaiya Akter", sex: "female", dob: "2017-05-01", phone: "1711234567", owner: "family", upazila: "Mirpur", conf: "verified", guardian: ["father", "আব্দুল করিম", "1711234567"] },
    { id: "p_ayesha", no: "GLC-230150", bn: "আয়েশা বেগম", en: "Ayesha Begum", sex: "female", approx: 71, phone: "1711234567", owner: "family", upazila: "Mirpur", conf: "unverified", guardian: ["son", "আব্দুল করিম", "1711234567"] },
    { id: "p_rbegum", no: "GLC-230982", bn: "রহিমা বেগম", en: "Rahima Begum", sex: "female", dob: "1968-01-10", phone: "1711234567", owner: "family", upazila: "Pallabi", conf: "possible_duplicate", guardian: ["husband", "মো. হাশেম", "1711234567"] },
    { id: "p_farzana", no: "GLC-240188", bn: "ফারজানা আক্তার", en: "Farzana Akter", sex: "female", dob: "1995-06-02", phone: "1711908812", owner: "self", upazila: "Mirpur", conf: "verified" },
    { id: "p_shahidul", no: "GLC-240201", bn: "শহিদুল ইসলাম", en: "Shahidul Islam", sex: "male", dob: "1969-01-20", phone: "1811223344", owner: "self", upazila: "Mirpur", conf: "verified" },
    { id: "p_nasrin", no: "GLC-240210", bn: "নাসরিন সুলতানা", en: "Nasrin Sultana", sex: "female", dob: "1988-11-11", phone: "1911556677", owner: "self", upazila: "Mirpur", conf: "verified" },
  ];
  /* The same family in any tenant: ids get `idPrefix`, facility numbers the tenant's prefix. */
  const seedFamily = async (tenantId: string, idPrefix: string, noPrefix: string) => { for (const p of patients) {
    const x = { ...p, id: idPrefix + p.id, no: p.no.replace(/^GLC/, noPrefix) };
    const data = {
      facilityNo: x.no, nameBn: x.bn, nameEn: x.en, sex: x.sex, birthDate: x.dob ? new Date(x.dob + "T00:00:00Z") : null,
      approxAgeYears: x.approx ?? null, approxAgeAt: x.approx ? new Date("2026-09-01T00:00:00Z") : null,
      phone: x.phone, phoneOwner: x.owner, division: "Dhaka", district: "Dhaka", upazila: x.upazila,
      identityConfidence: x.conf, identityMethod: "desk",
    };
    // `linkedToId: null` and the seeded confidence on every run: a seed run resets the walkthrough family.
    await prisma.patient.upsert({ where: { id: x.id }, update: { ...data, linkedToId: null }, create: { id: x.id, tenantId, ...data } });
    if (x.guardian) {
      const [relationship, nameBn, phone] = x.guardian;
      await prisma.relatedPerson.upsert({ where: { id: `rp_${x.id}` }, update: { relationship, nameBn, phone }, create: { id: `rp_${x.id}`, tenantId, patientId: x.id, relationship, nameBn, phone } });
    }
  } };
  await seedFamily(tenant.id, "", "GLC");
  /* Walkthrough A4: Rahima Khatun's previous visit on 12/08/2026 with the vitals the vitals screen shows as "last"
     (BP 145/90; weight 57 kg, so today's 58 kg reads "+1 kg since last visit"). Synthetic. */
  const seedLastVisit = async (tenantId: string, organizationId: string, branchId: string, idPrefix: string, nurseId: string) => {
    const encId = `${idPrefix}enc_rahima_20260812`;
    await prisma.encounter.upsert({ where: { id: encId }, update: {}, create: {
      id: encId, tenantId, organizationId, branchId, patientId: `${idPrefix}p_rahima`, class: "opd", status: "finished", visitType: "follow-up",
      token: "A-009", tokenNo: 9, tokenDay: "2026-08-12", arrivedAt: new Date("2026-08-12T03:40:00Z"), statusAt: new Date("2026-08-12T05:10:00Z"),
      createdById: nurseId, createdAt: new Date("2026-08-12T03:40:00Z"),
    } });
    const batchId = `${idPrefix}vb_rahima_20260812`;
    if (await prisma.observation.count({ where: { batchId } })) return;
    const at = new Date("2026-08-12T04:05:00Z");
    const base = { tenantId, organizationId, branchId, patientId: `${idPrefix}p_rahima`, encounterId: encId, batchId, recordedById: nurseId, effectiveAt: at, recordedAt: at, category: "vital-signs" };
    await prisma.observation.createMany({ data: [
      { ...base, code: "bp-systolic", value: 145, unit: "mmHg", interpretation: "H" },
      { ...base, code: "bp-diastolic", value: 90, unit: "mmHg", interpretation: "H" },
      { ...base, code: "pulse", value: 88, unit: "/min", interpretation: "N" },
      { ...base, code: "body-temperature", value: 98.6, unit: "[degF]", interpretation: "N" },
      { ...base, code: "spo2", value: 98, unit: "%", interpretation: "N" },
      { ...base, code: "blood-glucose", value: 9.8, unit: "mmol/L", method: "random", interpretation: "N" },
      { ...base, code: "body-weight", value: 57, unit: "kg", interpretation: null },
      { ...base, code: "body-height", value: 152, unit: "cm", interpretation: null },
      { ...base, code: "bmi", value: 24.7, unit: "kg/m2", method: "calculated", interpretation: null },
    ] });
    await prisma.provenance.create({ data: { tenantId, targetType: "Observation", targetId: batchId, activity: "record-vitals", agentId: nurseId, onBehalfOf: organizationId, source: "provider_verified", recorded: at, detail: { encounterId: encId, seeded: true } } });
  };
  await seedLastVisit(tenant.id, org.id, "l_branch_mirpur", "", "u_shirin");
  await seedLastNote(tenant.id, org.id, "l_branch_mirpur", "", "u_selina");
  await seedLabHistory(tenant.id, org.id, "l_branch_mirpur", "", "u_tanvir", "u_kanta");
  /* Two small tenants on the lower plans, so the plan-lock journey runs against the real database (one user each,
     on their own phone numbers: login refuses a phone+password that matches in more than one tenant). */
  const planDemos: [string, string, "clinic" | "lite", string, string, string, string, string, "nurse" | "doctor"][] = [
    ["t_clinicdemo", "o_clinicdemo", "clinic", "Shapla Clinic (Clinic plan demo)", "শাপলা ক্লিনিক", "u_clinic_nurse", "রুনা বেগম", "Runa Begum", "nurse"],
    ["t_litedemo", "o_litedemo", "lite", "Meghna Hospital (Hospital Lite demo)", "মেঘনা হাসপাতাল", "u_lite_doctor", "ডা. ফাহিম আহমেদ", "Dr. Fahim Ahmed", "doctor"],
  ];
  const planPhones: Record<string, string> = { u_clinic_nurse: "01722000004", u_lite_doctor: "01733000002" };
  for (const [tid, oid, plan, name, nameBn, uid, uBn, uEn, role] of planDemos) {
    const patientNoPrefix = tid === "t_clinicdemo" ? "SHC" : "MGH";
    await prisma.tenant.upsert({ where: { id: tid }, update: { patientNoPrefix }, create: { id: tid, name, plan, patientNoPrefix } });
    await prisma.organization.upsert({ where: { id: oid }, update: {}, create: { id: oid, tenantId: tid, name, nameBn, ...LIVE } });
    await prisma.location.upsert({ where: { id: `l_branch_${tid}` }, update: {}, create: { id: `l_branch_${tid}`, tenantId: tid, organizationId: oid, kind: "branch", name: "Main branch", nameBn: "প্রধান শাখা" } });
    await prisma.user.upsert({ where: { id: uid }, update: {}, create: { id: uid, tenantId: tid, nameBn: uBn, nameEn: uEn, phone: planPhones[uid], passwordHash: hash("setu1234"), pinHash: hash("1234") } });
    await prisma.practitionerRole.upsert({ where: { userId_organizationId_role: { userId: uid, organizationId: oid, role } }, update: {}, create: { tenantId: tid, userId: uid, organizationId: oid, role } });
  }
  await prisma.sequence.upsert({ where: { tenantId_name: { tenantId: tenant.id, name: "patient" } }, update: {}, create: { tenantId: tenant.id, name: "patient", value: 240210 } });

  /* E2E Test Clinic: the API contract tests and the Playwright journeys run here, so the patients and visits they create
     never appear in the demo clinic's queue. Same family, own users (phones 017990000xx), own branch and numbers. */
  const E2E = { tenant: "t_e2e", org: "o_e2e", branch: "l_branch_e2e" };
  await prisma.tenant.upsert({ where: { id: E2E.tenant }, update: { patientNoPrefix: "E2E" }, create: { id: E2E.tenant, name: "E2E Test Clinic", plan: "pro", patientNoPrefix: "E2E" } });
  await prisma.organization.upsert({ where: { id: E2E.org }, update: {}, create: { id: E2E.org, tenantId: E2E.tenant, name: "E2E Test Clinic", nameBn: "ই২ই টেস্ট ক্লিনিক", ...LIVE } });
  await prisma.location.upsert({ where: { id: E2E.branch }, update: {}, create: { id: E2E.branch, tenantId: E2E.tenant, organizationId: E2E.org, kind: "branch", name: "Test branch", nameBn: "টেস্ট শাখা" } });
  const e2eUsers: [string, string, string, string, "receptionist" | "doctor" | "nurse" | "labTech" | "pathologist" | "pharmacist" | "cashier" | "owner" | "admin"][] = [
    ["u_e2e_desk", "টেস্ট রিসেপশন", "Test Receptionist", "01799000001", "receptionist"],
    ["u_e2e_doctor", "ডা. টেস্ট", "Dr. Test", "01799000002", "doctor"],
    ["u_e2e_doctor2", "ডা. টেস্ট দুই", "Dr. Test Two", "01799000003", "doctor"],
    ["u_e2e_nurse", "টেস্ট নার্স", "Test Nurse", "01799000004", "nurse"],
    // Slice A8–A11: the plan is Hospital Pro, so technical verify and clinical validation need two different people.
    ["u_e2e_labtech", "টেস্ট টেকনোলজিস্ট", "Test Lab Technologist", "01799000005", "labTech"],
    ["u_e2e_path", "ডা. টেস্ট প্যাথলজিস্ট", "Dr. Test Pathologist", "01799000006", "pathologist"],
    // Pharmacy slice (ADR 0009): the E2E pharmacist (journey P1–P6)
    ["u_e2e_pharm", "টেস্ট ফার্মাসিস্ট", "Test Pharmacist", "01799000007", "pharmacist"],
    ["u_e2e_cashier", "টেস্ট ক্যাশিয়ার", "Test Cashier", "01799000008", "cashier"],
    ["u_e2e_owner", "টেস্ট মালিক", "Test Owner", "01799000009", "owner"],
    ["u_e2e_admin", "টেস্ট অ্যাডমিন", "Test Admin", "01799000010", "admin"],
    // Refunds (ADR 0013): a second cashier with a drawer of their own, so journey R never shares one with journey C4
    ["u_e2e_cashier2", "টেস্ট ক্যাশিয়ার দুই", "Test Cashier Two", "01799000012", "cashier"],
  ];
  for (const [id, nameBn, nameEn, phone, role] of e2eUsers) {
    await prisma.user.upsert({ where: { id }, update: {}, create: { id, tenantId: E2E.tenant, nameBn, nameEn, phone, passwordHash: hash("setu1234"), pinHash: hash("1234") } });
    await prisma.practitionerRole.upsert({ where: { userId_organizationId_role: { userId: id, organizationId: E2E.org, role } }, update: {}, create: { tenantId: E2E.tenant, userId: id, organizationId: E2E.org, role } });
  }
  /* Admin slice (ADR 0010): facilities still in setup, each with its own admin — the onboarding journey takes them live
     (pnpm reset-e2e puts the E2E one back into setup). Green Life's Uttara branch is for the hands-on walkthrough. */
  for (const [tid, oid, name, nameBn, uid, uBn, uEn, phone] of [
    [E2E.tenant, "o_e2e_new", "E2E New Clinic", "ই২ই নতুন ক্লিনিক", "u_e2e_newadmin", "নতুন অ্যাডমিন", "New Clinic Admin", "01799000011"],
    [tenant.id, "o_greenlife_uttara", "Green Life Clinic, Uttara", "গ্রীন লাইফ ক্লিনিক, উত্তরা", "u_gl_uttara_admin", "উত্তরা অ্যাডমিন", "Uttara Admin", "1711000011"],
  ] as const) {
    await prisma.organization.upsert({ where: { id: oid }, update: {}, create: { id: oid, tenantId: tid, name, nameBn, status: "setup" } });
    await prisma.user.upsert({ where: { id: uid }, update: {}, create: { id: uid, tenantId: tid, nameBn: uBn, nameEn: uEn, phone, passwordHash: hash("setu1234"), pinHash: hash("2580") } });
    await prisma.practitionerRole.upsert({ where: { userId_organizationId_role: { userId: uid, organizationId: oid, role: "admin" } }, update: {}, create: { tenantId: tid, userId: uid, organizationId: oid, role: "admin" } });
  }
  await seedFamily(E2E.tenant, "e2e_", "E2E");
  await seedLastVisit(E2E.tenant, E2E.org, E2E.branch, "e2e_", "u_e2e_nurse");
  await seedLastNote(E2E.tenant, E2E.org, E2E.branch, "e2e_", "u_e2e_doctor");
  await seedLabHistory(E2E.tenant, E2E.org, E2E.branch, "e2e_", "u_e2e_labtech", "u_e2e_path");
  /* ADR 0014 (slice B1–B2): the E2E Lite hospital — a Hospital Lite tenant of its own, on its own phone numbers
     (017980000xx), with wards and beds for the ER and admission journeys and API tests. The same walkthrough family.
     Doctors carry a speciality (walkthrough issue #24: an adult assigned to the paediatrician gets a prompt). */
  const LITE = { tenant: "t_e2e_lite", org: "o_e2e_lite", branch: "l_branch_e2e_lite" };
  await prisma.tenant.upsert({ where: { id: LITE.tenant }, update: { patientNoPrefix: "E2L" }, create: { id: LITE.tenant, name: "E2E Lite Hospital", plan: "lite", patientNoPrefix: "E2L" } });
  await prisma.organization.upsert({ where: { id: LITE.org }, update: {}, create: { id: LITE.org, tenantId: LITE.tenant, name: "E2E Lite Hospital", nameBn: "ই২ই লাইট হাসপাতাল", ...LIVE } });
  await prisma.location.upsert({ where: { id: LITE.branch }, update: {}, create: { id: LITE.branch, tenantId: LITE.tenant, organizationId: LITE.org, kind: "branch", name: "Main branch", nameBn: "প্রধান শাখা" } });
  const liteUsers: [string, string, string, string, "receptionist" | "doctor" | "nurse" | "cashier" | "owner" | "admin", string | null][] = [
    ["u_e2l_desk", "লাইট রিসেপশন", "Lite Receptionist", "01798000001", "receptionist", null],
    ["u_e2l_doctor", "ডা. লাইট ইমার্জেন্সি", "Dr. Lite Emergency", "01798000002", "doctor", "Emergency medicine"],
    ["u_e2l_paed", "ডা. লাইট শিশু", "Dr. Lite Paediatrics", "01798000003", "doctor", "Paediatrics"],
    ["u_e2l_surgeon", "ডা. লাইট সার্জন", "Dr. Lite Surgeon", "01798000005", "doctor", "Surgery"],
    ["u_e2l_nurse", "লাইট নার্স", "Lite Nurse", "01798000004", "nurse", null],
    ["u_e2l_cashier", "লাইট ক্যাশিয়ার", "Lite Cashier", "01798000008", "cashier", null],
    ["u_e2l_owner", "লাইট মালিক", "Lite Owner", "01798000009", "owner", null],
    ["u_e2l_admin", "লাইট অ্যাডমিন", "Lite Admin", "01798000010", "admin", null],
  ];
  for (const [id, nameBn, nameEn, phone, role, speciality] of liteUsers) {
    await prisma.user.upsert({ where: { id }, update: {}, create: { id, tenantId: LITE.tenant, nameBn, nameEn, phone, passwordHash: hash("setu1234"), pinHash: hash("1234") } });
    await prisma.practitionerRole.upsert({ where: { userId_organizationId_role: { userId: id, organizationId: LITE.org, role } }, update: {}, create: { tenantId: LITE.tenant, userId: id, organizationId: LITE.org, role } });
    if (speciality) await prisma.practitioner.upsert({ where: { userId: id }, update: { speciality }, create: { tenantId: LITE.tenant, userId: id, speciality } });
  }
  await seedFamily(LITE.tenant, "e2l_", "E2L");
  await seedWards(LITE.tenant, LITE.org, LITE.branch, "e2l_");
  await prisma.sequence.upsert({ where: { tenantId_name: { tenantId: LITE.tenant, name: "patient" } }, update: {}, create: { tenantId: LITE.tenant, name: "patient", value: 240210 } });
  /* The Hospital Lite demo gets the same wards for the hands-on walkthrough; Green Life (already has ward 2A) gets an
     ER ward of bays and an HDU. The demo doctors' specialities are the prototype's. */
  await seedWards("t_litedemo", "o_litedemo", "l_branch_t_litedemo", "lite_");
  await seedWards(tenant.id, org.id, "l_branch_mirpur", "", ["er", "hdu"]);
  for (const [userId, speciality] of [["u_imran", "Emergency medicine"], ["u_selina", "Obs & Gynae"], ["u_lite_doctor", "Medicine"]] as const) {
    const u = await prisma.user.findUnique({ where: { id: userId } });
    if (u) await prisma.practitioner.upsert({ where: { userId }, update: { speciality }, create: { tenantId: u.tenantId, userId, speciality } });
  }
  for (const t of [tenant.id, "t_clinicdemo", "t_litedemo", E2E.tenant, LITE.tenant]) { await seedCatalogues(t); await seedLabCatalogues(t); }
  for (const [t, o] of [[tenant.id, org.id], ["t_clinicdemo", "o_clinicdemo"], ["t_litedemo", "o_litedemo"], [E2E.tenant, E2E.org], [LITE.tenant, LITE.org]] as const) await seedPriceList(t, o);
  for (const [t, o, by] of [[tenant.id, org.id, "u_jewel"], [E2E.tenant, E2E.org, "u_e2e_pharm"]] as const) await seedStock(t, o, by);
  /* Pharmacy session 2 (ADR 0009): sample suppliers (distributors) for purchase orders — names are samples. */
  for (const [t, o] of [[tenant.id, org.id], [E2E.tenant, E2E.org]] as const)
    for (const name of ["Square Pharma Distribution (sample)", "Incepta Distribution (sample)", "Beximco Pharma Depot (sample)"])
      await prisma.supplier.upsert({ where: { tenantId_organizationId_name: { tenantId: t, organizationId: o, name } }, update: {}, create: { tenantId: t, organizationId: o, name, sample: true } });
  /* The prototype's sample seller BIN (receipt header), marked sample; the plan demos have none, so no Mushak-6.3 line. */
  for (const id of [org.id, E2E.org]) await prisma.organization.update({ where: { id }, data: { vatBin: "000123456-0101", vatBinSample: true } });
  await prisma.sequence.upsert({ where: { tenantId_name: { tenantId: E2E.tenant, name: "patient" } }, update: {}, create: { tenantId: E2E.tenant, name: "patient", value: 240210 } });
  console.log("seeded demo tenant: Green Life Clinic, Mirpur — 10 users (password setu1234, PIN 1234), 8 patients (5 share 01711-234567), Mirpur branch, ward 2A; plan demos: Clinic-plan nurse 01722000004, Lite-plan doctor 01733000002; E2E Test Clinic (tests only): 017990000xx; E2E Lite Hospital (tests only, Hospital Lite, wards and beds): 017980000xx; Rahima Khatun's previous visit 12/08/2026 with vitals");
}

main().finally(() => prisma.$disconnect());
