/* ADR 0022 — the portable lab order (Journey E1–E2): the doctor's network tests, the patient's (or the desk's) choice of
   a network centre, the centre's decision (all, part, none — a reason for each declined test), re-ordering elsewhere.
   Visible to the ordering facility, the patient and the chosen centre only. */
import { z } from "zod";
import { Paisa } from "./common.js";

export const PortableStatus = z.enum(["active", "centre-chosen", "accepted", "partially-accepted", "declined", "revoked"]);
export const PortableItemView = z.object({
  id: z.string(), testCode: z.string(), nameEn: z.string(), nameBn: z.string(),
  status: z.enum(["pending", "accepted", "declined"]), declineReason: z.string().nullable(), notOffered: z.boolean(),
  /** the chosen centre's price (paisa), once chosen */
  unitPaisa: Paisa.nullable(),
  /** re-ordered elsewhere (the new order's id) */
  reorderedToId: z.string().nullable(),
});
export const PortableStep = z.object({ step: z.enum(["ordered", "centre-chosen", "decided", "reordered"]), at: z.string(), by: z.string().nullable() });
export const PortableOrderView = z.object({
  id: z.string(), number: z.string(), status: PortableStatus, createdAt: z.string(),
  origin: z.object({ facilityEn: z.string(), facilityBn: z.string().nullable(), doctorEn: z.string(), doctorBn: z.string() }),
  /** the minimum the chosen centre gets: name, sex, age, phone */
  patient: z.object({ nameEn: z.string().nullable(), nameBn: z.string(), sex: z.string(), ageYears: z.number().int().nullable(), phone: z.string().nullable() }),
  centre: z.object({ organizationId: z.string(), facilityEn: z.string().nullable(), facilityBn: z.string().nullable(), collection: z.enum(["centre", "home"]) }).nullable(),
  chosenBy: z.enum(["patient", "desk"]).nullable(),
  items: z.array(PortableItemView),
  /** the order these tests were re-ordered from */
  reorderOfId: z.string().nullable(),
  steps: z.array(PortableStep),
  /** who is reading: the ordering facility, the chosen centre, or the patient (what they may do next) */
  viewer: z.enum(["origin", "centre", "patient"]),
  canChoose: z.boolean(), canDecide: z.boolean(), reorderable: z.array(z.string()),
});
export type PortableOrderView = z.infer<typeof PortableOrderView>;
export const PortableList = z.object({ items: z.array(PortableOrderView) });
export type PortableList = z.infer<typeof PortableList>;

export const CentreOfferView = z.object({
  tenantId: z.string(), organizationId: z.string(), nameEn: z.string(), nameBn: z.string().nullable(), area: z.string().nullable(),
  homeCollection: z.boolean(), homeCollectionFeePaisa: Paisa, turnaroundHours: z.number().int(),
  offered: z.array(z.object({ itemId: z.string(), testCode: z.string(), unitPaisa: Paisa })), notOffered: z.array(z.string()),
  testsPaisa: Paisa, homeFeePaisa: Paisa, totalPaisa: Paisa,
});
export const CentreOffers = z.object({ orderId: z.string(), sort: z.enum(["price", "turnaround"]), collection: z.enum(["centre", "home"]), centres: z.array(CentreOfferView) });
export type CentreOffers = z.infer<typeof CentreOffers>;
export const ChooseCentreRequest = z.object({ organizationId: z.string().min(1).max(64), collection: z.enum(["centre", "home"]).default("centre") });
export type ChooseCentreRequest = z.infer<typeof ChooseCentreRequest>;
export const CentreDecisionRequest = z.object({ items: z.array(z.object({ itemId: z.string().min(1).max(64), accept: z.boolean(), reason: z.string().trim().max(300).optional() })).min(1).max(30) });
export type CentreDecisionRequest = z.infer<typeof CentreDecisionRequest>;
