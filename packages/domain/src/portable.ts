/* ADR 0022 — the portable lab order (Journey E1–E2). The doctor orders tests "the patient chooses where"; the patient
   (or the ordering facility's desk for them) picks a network centre by its offer; the centre accepts all, part or none —
   a reason of 10+ characters for each declined test; declined tests can be re-ordered elsewhere, once each. The ORDER
   machine (machines.ts) carries the order's state; the server decides every step here. */
import { ORDER, transition, type OrderState } from "./machines.js";

export const portableOrderNumber = (yymm: string, n: number) => `LO-${yymm}-${String(n).padStart(4, "0")}`;
export const DECLINE_REASON_MIN = 10;

/** a centre's network catalogue (its own tests offered to the network, at its own prices) */
export interface CentreCatalogue {
  organizationId: string; nameEn: string;
  tests: { testCode: string; unitPaisa: number }[];
  homeCollection: boolean; homeCollectionFeePaisa: number; turnaroundHours: number;
}
export interface CentreOffer {
  organizationId: string;
  offered: { itemId: string; testCode: string; unitPaisa: number }[];
  notOffered: string[];
  testsPaisa: number; homeFeePaisa: number; totalPaisa: number; turnaroundHours: number;
  /** offers at least one test, and home collection when asked for */
  usable: boolean;
}
export function centreOffer(items: { id: string; testCode: string }[], c: CentreCatalogue, collection: "centre" | "home"): CentreOffer {
  const offered = items.flatMap((i) => { const t = c.tests.find((x) => x.testCode === i.testCode); return t ? [{ itemId: i.id, testCode: i.testCode, unitPaisa: t.unitPaisa }] : []; });
  const notOffered = items.filter((i) => !offered.some((o) => o.itemId === i.id)).map((i) => i.id);
  const testsPaisa = offered.reduce((a, o) => a + o.unitPaisa, 0);
  const home = collection === "home";
  const homeFeePaisa = home && c.homeCollection ? c.homeCollectionFeePaisa : 0;
  return { organizationId: c.organizationId, offered, notOffered, testsPaisa, homeFeePaisa, totalPaisa: testsPaisa + homeFeePaisa, turnaroundHours: c.turnaroundHours, usable: offered.length > 0 && (!home || c.homeCollection) };
}
/** usable offers only; the ones offering more of the order first, then by price or turnaround */
export function sortOffers(offers: CentreOffer[], by: "price" | "turnaround"): CentreOffer[] {
  return offers.filter((o) => o.usable).sort((a, b) => b.offered.length - a.offered.length
    || (by === "price" ? a.totalPaisa - b.totalPaisa || a.turnaroundHours - b.turnaroundHours : a.turnaroundHours - b.turnaroundHours || a.totalPaisa - b.totalPaisa)
    || a.organizationId.localeCompare(b.organizationId));
}

export type ChooseProblem = "not_waiting" | "nothing_offered";
export function chooseCentreProblems(status: OrderState, offer: CentreOffer): ChooseProblem[] {
  const out: ChooseProblem[] = [];
  if (status !== "active") out.push("not_waiting");
  if (!offer.offered.length) out.push("nothing_offered");
  return out;
}

export type DecisionProblem = { itemId: string | null; code: "not_waiting" | "unknown_item" | "not_offered" | "undecided" | "reason_too_short" };
export type ItemDecision = { itemId: string; accept: boolean; reason: string | null; notOffered?: true };
/** the centre's answer: every offered test accepted or declined (a reason of 10+ characters), a test it does not offer
    declined for that; → ORDER accept (all) | acceptPartial | decline (none) */
export function decideOrder(status: OrderState, items: { id: string; offered: boolean }[], decisions: { itemId: string; accept: boolean; reason?: string | null }[]):
  { ok: true; status: OrderState; items: ItemDecision[] } | { ok: false; problems: DecisionProblem[] } {
  if (status !== "centre-chosen") return { ok: false, problems: [{ itemId: null, code: "not_waiting" }] };
  const problems: DecisionProblem[] = [];
  for (const d of decisions) {
    const i = items.find((x) => x.id === d.itemId);
    if (!i) problems.push({ itemId: d.itemId, code: "unknown_item" });
    else if (!i.offered && d.accept) problems.push({ itemId: d.itemId, code: "not_offered" });
    else if (!d.accept && i.offered && (d.reason ?? "").trim().length < DECLINE_REASON_MIN) problems.push({ itemId: d.itemId, code: "reason_too_short" });
  }
  for (const i of items) if (i.offered && !decisions.some((d) => d.itemId === i.id)) problems.push({ itemId: i.id, code: "undecided" });
  if (problems.length) return { ok: false, problems };
  const out: ItemDecision[] = items.map((i) => {
    if (!i.offered) return { itemId: i.id, accept: false, reason: null, notOffered: true };
    const d = decisions.find((x) => x.itemId === i.id)!;
    return { itemId: i.id, accept: d.accept, reason: d.accept ? null : d.reason!.trim() };
  });
  const n = out.filter((x) => x.accept).length;
  const event = n === out.length ? "accept" : n === 0 ? "decline" : "acceptPartial";
  return { ok: true, status: transition("order", ORDER, status, event), items: out };
}

/** declined tests that may be re-ordered elsewhere — each once */
export const reorderable = (items: { id: string; status: string; reorderedToId: string | null }[]) => items.filter((i) => i.status === "declined" && !i.reorderedToId).map((i) => i.id);

export type PortableViewer = { kind: "staff"; tenantId: string } | { kind: "person"; linked: { tenantId: string; patientId: string }[] };
/** the ordering facility, the patient (their linked record), and the chosen centre once chosen — nobody else */
export function canSeePortable(o: { originTenantId: string; originPatientId: string; centreTenantId: string | null }, v: PortableViewer): boolean {
  if (v.kind === "person") return v.linked.some((l) => l.tenantId === o.originTenantId && l.patientId === o.originPatientId);
  return v.tenantId === o.originTenantId || (o.centreTenantId !== null && v.tenantId === o.centreTenantId);
}
