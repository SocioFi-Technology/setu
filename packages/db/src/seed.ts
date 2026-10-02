/* Demo tenant used by dev, e2e and the journeys: Green Life Clinic, Mirpur (the prototype's sample facility).
   Sample people match the walkthrough so Playwright specs read like the journey text. */
import { createHash } from "node:crypto";
import { owner as prisma } from "./owner.ts";

const hash = (s: string) => createHash("sha256").update("dev-only:" + s).digest("hex"); // replaced by argon2 in the auth slice

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { id: "t_greenlife" },
    update: { patientNoPrefix: "GLC" },
    create: { id: "t_greenlife", name: "Green Life Clinic", plan: "pro", patientNoPrefix: "GLC" },
  });
  const org = await prisma.organization.upsert({
    where: { id: "o_greenlife_mirpur" },
    update: {},
    create: { id: "o_greenlife_mirpur", tenantId: tenant.id, name: "Green Life Clinic, Mirpur", nameBn: "গ্রিন লাইফ ক্লিনিক, মিরপুর", address: "Mirpur, Dhaka" },
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
    await prisma.organization.upsert({ where: { id: oid }, update: {}, create: { id: oid, tenantId: tid, name, nameBn } });
    await prisma.location.upsert({ where: { id: `l_branch_${tid}` }, update: {}, create: { id: `l_branch_${tid}`, tenantId: tid, organizationId: oid, kind: "branch", name: "Main branch", nameBn: "প্রধান শাখা" } });
    await prisma.user.upsert({ where: { id: uid }, update: {}, create: { id: uid, tenantId: tid, nameBn: uBn, nameEn: uEn, phone: planPhones[uid], passwordHash: hash("setu1234"), pinHash: hash("1234") } });
    await prisma.practitionerRole.upsert({ where: { userId_organizationId_role: { userId: uid, organizationId: oid, role } }, update: {}, create: { tenantId: tid, userId: uid, organizationId: oid, role } });
  }
  await prisma.sequence.upsert({ where: { tenantId_name: { tenantId: tenant.id, name: "patient" } }, update: {}, create: { tenantId: tenant.id, name: "patient", value: 240210 } });

  /* E2E Test Clinic: the API contract tests and the Playwright journeys run here, so the patients and visits they create
     never appear in the demo clinic's queue. Same family, own users (phones 017990000xx), own branch and numbers. */
  const E2E = { tenant: "t_e2e", org: "o_e2e", branch: "l_branch_e2e" };
  await prisma.tenant.upsert({ where: { id: E2E.tenant }, update: { patientNoPrefix: "E2E" }, create: { id: E2E.tenant, name: "E2E Test Clinic", plan: "pro", patientNoPrefix: "E2E" } });
  await prisma.organization.upsert({ where: { id: E2E.org }, update: {}, create: { id: E2E.org, tenantId: E2E.tenant, name: "E2E Test Clinic", nameBn: "ই২ই টেস্ট ক্লিনিক" } });
  await prisma.location.upsert({ where: { id: E2E.branch }, update: {}, create: { id: E2E.branch, tenantId: E2E.tenant, organizationId: E2E.org, kind: "branch", name: "Test branch", nameBn: "টেস্ট শাখা" } });
  const e2eUsers: [string, string, string, string, "receptionist" | "doctor" | "nurse" | "owner" | "admin"][] = [
    ["u_e2e_desk", "টেস্ট রিসেপশন", "Test Receptionist", "01799000001", "receptionist"],
    ["u_e2e_doctor", "ডা. টেস্ট", "Dr. Test", "01799000002", "doctor"],
    ["u_e2e_nurse", "টেস্ট নার্স", "Test Nurse", "01799000004", "nurse"],
    ["u_e2e_owner", "টেস্ট মালিক", "Test Owner", "01799000009", "owner"],
    ["u_e2e_admin", "টেস্ট অ্যাডমিন", "Test Admin", "01799000010", "admin"],
  ];
  for (const [id, nameBn, nameEn, phone, role] of e2eUsers) {
    await prisma.user.upsert({ where: { id }, update: {}, create: { id, tenantId: E2E.tenant, nameBn, nameEn, phone, passwordHash: hash("setu1234"), pinHash: hash("1234") } });
    await prisma.practitionerRole.upsert({ where: { userId_organizationId_role: { userId: id, organizationId: E2E.org, role } }, update: {}, create: { tenantId: E2E.tenant, userId: id, organizationId: E2E.org, role } });
  }
  await seedFamily(E2E.tenant, "e2e_", "E2E");
  await seedLastVisit(E2E.tenant, E2E.org, E2E.branch, "e2e_", "u_e2e_nurse");
  await prisma.sequence.upsert({ where: { tenantId_name: { tenantId: E2E.tenant, name: "patient" } }, update: {}, create: { tenantId: E2E.tenant, name: "patient", value: 240210 } });
  console.log("seeded demo tenant: Green Life Clinic, Mirpur — 10 users (password setu1234, PIN 1234), 8 patients (5 share 01711-234567), Mirpur branch, ward 2A; plan demos: Clinic-plan nurse 01722000004, Lite-plan doctor 01733000002; E2E Test Clinic (tests only): 017990000xx; Rahima Khatun's previous visit 12/08/2026 with vitals");
}

main().finally(() => prisma.$disconnect());
