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
  for (const x of patients) {
    const data = {
      facilityNo: x.no, nameBn: x.bn, nameEn: x.en, sex: x.sex, birthDate: x.dob ? new Date(x.dob + "T00:00:00Z") : null,
      approxAgeYears: x.approx ?? null, approxAgeAt: x.approx ? new Date("2026-09-01T00:00:00Z") : null,
      phone: x.phone, phoneOwner: x.owner, division: "Dhaka", district: "Dhaka", upazila: x.upazila,
      identityConfidence: x.conf, identityMethod: "desk",
    };
    await prisma.patient.upsert({ where: { id: x.id }, update: data, create: { id: x.id, tenantId: tenant.id, ...data } });
    if (x.guardian) {
      const [relationship, nameBn, phone] = x.guardian;
      await prisma.relatedPerson.upsert({ where: { id: `rp_${x.id}` }, update: { relationship, nameBn, phone }, create: { id: `rp_${x.id}`, tenantId: tenant.id, patientId: x.id, relationship, nameBn, phone } });
    }
  }
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
  console.log("seeded demo tenant: Green Life Clinic, Mirpur — 10 users (password setu1234, PIN 1234), 8 patients (5 share 01711-234567), Mirpur branch, ward 2A; plan demos: Clinic-plan nurse 01722000004, Lite-plan doctor 01733000002");
}

main().finally(() => prisma.$disconnect());
