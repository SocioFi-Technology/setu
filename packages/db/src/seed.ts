/* Demo tenant used by dev, e2e and the journeys: Green Life Clinic, Mirpur (the prototype's sample facility).
   Sample people match the walkthrough so Playwright specs read like the journey text. */
import { createHash } from "node:crypto";
import { prisma } from "./index.ts";

const hash = (s: string) => createHash("sha256").update("dev-only:" + s).digest("hex"); // replaced by argon2 in the auth slice

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { id: "t_greenlife" },
    update: {},
    create: { id: "t_greenlife", name: "Green Life Clinic", plan: "pro" },
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
  const patients: [string, string, string, string, "male" | "female", string, string][] = [
    ["p_rahima", "GLC-240117", "রহিমা খাতুন", "Rahima Khatun", "female", "1984-03-15", "01711908812"],
    ["p_farzana", "GLC-240188", "ফারজানা আক্তার", "Farzana Akter", "female", "1995-06-02", "01711908812"],
    ["p_shahidul", "GLC-240201", "শহিদুল ইসলাম", "Shahidul Islam", "male", "1969-01-20", "01811223344"],
    ["p_nasrin", "GLC-240210", "নাসরিন সুলতানা", "Nasrin Sultana", "female", "1988-11-11", "01911556677"],
  ];
  for (const [id, facilityNo, nameBn, nameEn, sex, dob, phone] of patients) {
    await prisma.patient.upsert({
      where: { id }, update: {},
      create: { id, tenantId: tenant.id, facilityNo, nameBn, nameEn, sex, birthDate: new Date(dob), phone, phoneOwner: "shared", district: "Dhaka", upazila: "Mirpur", identityConfidence: "verified", identityMethod: "desk" },
    });
  }
  await prisma.sequence.upsert({ where: { tenantId_name: { tenantId: tenant.id, name: "patient" } }, update: {}, create: { tenantId: tenant.id, name: "patient", value: 240210 } });
  console.log("seeded demo tenant: Green Life Clinic, Mirpur — 10 users (password setu1234, PIN 1234), 4 patients, ward 2A");
}

main().finally(() => prisma.$disconnect());
