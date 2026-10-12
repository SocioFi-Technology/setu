/* ADR 0024 — the reception confirms a patient-app claim in person. The patient chose "verify at the reception": the app
   shows a desk code (only its hash is stored). At the counter the receptionist types that code — it proves the person
   standing there holds the app — checks an identity document, and picks this facility's record on the app's phone; or
   says it could not be verified. Only records on the person's phone are offered (never a search), every look and
   decision is audited here, and the facility's own identity decisions are not touched. */
import { createHash, randomInt } from "node:crypto";
import type { DeskClaimConfirm, DeskClaimResult, DeskClaimView } from "@setu/contracts";
import { CLAIM_CODE_ALPHABET, deskDecision, normalizeClaimCode, patientAgeYears, type ClaimState } from "@setu/domain";
import type { Tx } from "@setu/db";
import { counters } from "../adapters/counters.js";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";

/** a new desk code (the claim-code alphabet: no look-alikes) */
export const newDeskCode = () => Array.from({ length: 6 }, () => CLAIM_CODE_ALPHABET[randomInt(CLAIM_CODE_ALPHABET.length)]).join("");
/** what the table keeps: a hash bound to the facility, so a code is useless anywhere else */
export const deskCodeHash = (tenantId: string, code: string) => createHash("sha256").update(`desk:${tenantId}:${code}`).digest("hex");

/** wrong desk codes per receptionist (a code is 6 characters of 31: guessing needs millions of tries) */
const MISSES_PER_10_MIN = 10;
const dash = (s: string) => s.replace(/_/g, "-") as ClaimState;
const notFound = () => err(404, "desk_code", "এই কোডে কোনো অপেক্ষমাণ অনুরোধ নেই — রোগীর অ্যাপে কোডটি আবার দেখুন", "No app request waits with this code — check the code on the patient's app");

/** the claim behind a desk code, locked for a decision; a miss counts against the receptionist */
async function claimByCode(tx: Tx, s: SessionData, raw: string, now: Date, lock: boolean) {
  const key = `deskcode:${s.userId}`;
  if ((await counters().get(key)) >= MISSES_PER_10_MIN) throw err(429, "rate_limited", "অনেকবার ভুল কোড — ১০ মিনিট পরে চেষ্টা করুন", "Too many wrong codes — try again in 10 minutes");
  const code = normalizeClaimCode(raw);
  const c = code ? await tx.patientClaim.findFirst({ where: { tenantId: s.tenantId, deskCodeHash: deskCodeHash(s.tenantId, code) } }) : null;
  if (c && lock) await tx.$queryRaw`SELECT 1 FROM "PatientClaim" WHERE "id" = ${c.id} FOR UPDATE`;
  const fresh = c && lock ? await tx.patientClaim.findUnique({ where: { id: c.id } }) : c;
  if (!fresh || fresh.status !== "proof_pending" || fresh.method !== "desk" || !fresh.deskCodeUntil || fresh.deskCodeUntil.getTime() <= now.getTime()) {
    await counters().incr(key, 600_000);
    throw notFound();
  }
  const rows = await tx.$queryRaw<{ phone: string | null }[]>`SELECT desk_claim_phone(${fresh.id}::text) AS phone`;
  const phone = rows[0]?.phone;
  if (!phone) throw notFound();
  return { c: fresh, phone };
}
/** this facility's records on the app's phone (not merged-away ones) */
async function recordsOnPhone(tx: Tx, phone: string, now: Date): Promise<DeskClaimView["records"]> {
  const pts = await tx.patient.findMany({ where: { phone, linkedToId: null }, orderBy: { createdAt: "asc" },
    select: { id: true, facilityNo: true, nameBn: true, nameEn: true, sex: true, birthDate: true, approxAgeYears: true, approxAgeAt: true } });
  const last = await tx.encounter.groupBy({ by: ["patientId"], where: { patientId: { in: pts.map((p) => p.id) } }, _max: { createdAt: true } });
  return pts.map((p) => ({
    patientId: p.id, facilityNo: p.facilityNo, nameBn: p.nameBn, nameEn: p.nameEn, sex: p.sex as string,
    ageYears: patientAgeYears({ birthDate: p.birthDate?.toISOString().slice(0, 10) ?? null, approxAgeYears: p.approxAgeYears, approxAgeAt: p.approxAgeAt?.toISOString() ?? null }, now),
    lastVisitAt: last.find((l) => l.patientId === p.id)?._max.createdAt?.toISOString() ?? null,
  }));
}
const masked = (phone10: string) => `0${phone10.slice(0, 2)}*****${phone10.slice(-3)}`;

export async function deskLookup(tx: Tx, s: SessionData, code: string, now = new Date()): Promise<{ body: DeskClaimView; audit: AuditEntry[] }> {
  const { c, phone } = await claimByCode(tx, s, code, now, false);
  const records = await recordsOnPhone(tx, phone, now);
  return {
    body: { claimId: c.id, phoneMasked: masked(phone), codeUntil: c.deskCodeUntil!.toISOString(), records },
    audit: [{ action: "view", entity: "PatientClaim", entityId: c.id, detail: { purpose: "desk-claim", records: records.length } }],
  };
}

export async function deskConfirm(tx: Tx, s: SessionData, b: DeskClaimConfirm, now = new Date()): Promise<{ body: DeskClaimResult; audit: AuditEntry[] }> {
  const { c, phone } = await claimByCode(tx, s, b.code, now, true);
  const rec = (await recordsOnPhone(tx, phone, now)).find((r) => r.patientId === b.patientId);
  if (!rec) throw err(400, "not_on_phone", "এই রেকর্ড অ্যাপের ফোন নম্বরে নেই", "This record is not on the app's phone number", { field: "patientId" });
  const d = deskDecision({ status: dash(c.status), method: c.method, deskCodeUntil: c.deskCodeUntil }, "confirm", now);
  if ("refused" in d) throw notFound();
  await tx.patientClaim.update({ where: { id: c.id }, data: {
    status: "linked", patientId: rec.patientId, linkedAt: now, statusAt: now, deskDocument: b.document, deskById: s.userId, deskAt: now, deskCodeHash: null, deskCodeUntil: null,
  } });
  // who vouched: the receptionist, for the person, having seen the document (its number is not copied)
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Patient", targetId: rec.patientId, activity: "patient-app-claim", agentId: s.userId, onBehalfOf: `person:${c.personId}`, recorded: now, source: "desk_decision", detail: { method: "desk", document: b.document, claimId: c.id } as object } });
  return {
    body: { outcome: "linked", facilityNo: rec.facilityNo },
    audit: [{ action: "claim", entity: "PatientClaim", entityId: c.id, patientId: rec.patientId, detail: { method: "desk", outcome: "linked", document: b.document, person: c.personId } }],
  };
}

export async function deskRefuse(tx: Tx, s: SessionData, code: string, now = new Date()): Promise<{ body: DeskClaimResult; audit: AuditEntry[] }> {
  const { c } = await claimByCode(tx, s, code, now, true);
  const d = deskDecision({ status: dash(c.status), method: c.method, deskCodeUntil: c.deskCodeUntil }, "refuse", now);
  if ("refused" in d) throw notFound();
  await tx.patientClaim.update({ where: { id: c.id }, data: { status: "candidate", statusAt: now, deskCodeHash: null, deskCodeUntil: null, deskRefusedAt: now } });
  return { body: { outcome: "refused", facilityNo: null }, audit: [{ action: "claim", entity: "PatientClaim", entityId: c.id, detail: { method: "desk", outcome: "refused", person: c.personId } }] };
}
