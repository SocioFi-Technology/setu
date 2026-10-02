/* State machines from docs/design-handoff/domain-model.md.
   Routes call `transition`; screens import the same tables to enable/disable buttons.
   Add a machine here (and an ADR) before adding a status anywhere else. */

export type Table<S extends string, E extends string> = Record<S, Partial<Record<E, S>>>;

export class TransitionError extends Error {
  constructor(public machine: string, public from: string, public event: string) {
    super(`${machine}: cannot '${event}' from '${from}'`);
  }
}

export function transition<S extends string, E extends string>(machine: string, table: Table<S, E>, from: S, event: E): S {
  const to = table[from]?.[event];
  if (!to) throw new TransitionError(machine, from, event);
  return to;
}
export const can = <S extends string, E extends string>(table: Table<S, E>, from: S, event: E): boolean => Boolean(table[from]?.[event]);

/* Clinical document: Composition, DiagnosticReport, discharge summary, Rx.
   `sign` is only called after PIN check + server ack; offline sign goes to `queued` (unused in A4–A5: signing offline
   is disabled). ADR 0003: an amendment is a new row (v2) that starts as draft and signs with `signAmendment` — the
   route allows it only for a draft that amends another version — while the old version gets `supersede` in the same
   transaction. */
export type DocState = "draft" | "queued" | "final" | "amended" | "superseded" | "entered-in-error";
export type DocEvent = "sign" | "signAmendment" | "offlineSign" | "serverAck" | "amend" | "supersede" | "markError";
export const DOCUMENT: Table<DocState, DocEvent> = {
  draft: { sign: "final", signAmendment: "amended", offlineSign: "queued" },
  queued: { serverAck: "final" },
  final: { amend: "amended", supersede: "superseded", markError: "entered-in-error" },
  amended: { amend: "amended", supersede: "superseded", markError: "entered-in-error" },
  superseded: {},
  "entered-in-error": {},
};

/* Order (ServiceRequest, incl. network portable orders) */
export type OrderState = "draft" | "active" | "centre-chosen" | "accepted" | "partially-accepted" | "declined" | "in-progress" | "partially-complete" | "complete" | "revoked";
export type OrderEvent = "order" | "chooseCentre" | "accept" | "acceptPartial" | "decline" | "collect" | "resultFinal" | "allFinal" | "revoke";
export const ORDER: Table<OrderState, OrderEvent> = {
  draft: { order: "active" },
  active: { chooseCentre: "centre-chosen", collect: "in-progress", revoke: "revoked" },
  "centre-chosen": { accept: "accepted", acceptPartial: "partially-accepted", decline: "declined", revoke: "revoked" },
  accepted: { collect: "in-progress", revoke: "revoked" },
  "partially-accepted": { collect: "in-progress", revoke: "revoked" },
  declined: {},
  "in-progress": { resultFinal: "partially-complete", allFinal: "complete" },
  "partially-complete": { resultFinal: "partially-complete", allFinal: "complete" },
  complete: {},
  revoked: {},
};

export type SpecimenState = "pending" | "collected" | "received" | "in-process" | "done" | "rejected";
export type SpecimenEvent = "collect" | "receive" | "process" | "finish" | "reject";
export const SPECIMEN: Table<SpecimenState, SpecimenEvent> = {
  pending: { collect: "collected", reject: "rejected" },
  collected: { receive: "received", reject: "rejected" },
  received: { process: "in-process", reject: "rejected" },
  "in-process": { finish: "done", reject: "rejected" },
  done: {},
  rejected: {},
};

/* Result: critical values need a logged call-back before `final` — enforce in the route, not here. */
export type ResultState = "registered" | "preliminary" | "final" | "amended";
export type ResultEvent = "enter" | "validate" | "amend";
export const RESULT: Table<ResultState, ResultEvent> = {
  registered: { enter: "preliminary" },
  preliminary: { validate: "final" },
  final: { amend: "amended" },
  amended: { amend: "amended" },
};

export type InvoiceState = "draft" | "issued" | "partially-paid" | "balanced" | "cancelled";
export type InvoiceEvent = "issue" | "payPart" | "payAll" | "cancel";
export const INVOICE: Table<InvoiceState, InvoiceEvent> = {
  draft: { issue: "issued", cancel: "cancelled" },
  issued: { payPart: "partially-paid", payAll: "balanced", cancel: "cancelled" },
  "partially-paid": { payPart: "partially-paid", payAll: "balanced", cancel: "cancelled" },
  balanced: {},
  cancelled: {},
};

export type PaymentState = "initiated" | "link-sent" | "waiting-customer" | "confirmed" | "failed";
export type PaymentEvent = "sendLink" | "customerOpened" | "confirm" | "fail" | "retry";
export const PAYMENT: Table<PaymentState, PaymentEvent> = {
  initiated: { sendLink: "link-sent", confirm: "confirmed", fail: "failed" },
  "link-sent": { customerOpened: "waiting-customer", confirm: "confirmed", fail: "failed" },
  "waiting-customer": { confirm: "confirmed", fail: "failed" },
  confirmed: {},
  failed: { retry: "initiated" },
};

export type ApprovalState = "requested" | "approved" | "rejected";
export type ApprovalEvent = "approve" | "reject";
export const APPROVAL: Table<ApprovalState, ApprovalEvent> = { requested: { approve: "approved", reject: "rejected" }, approved: {}, rejected: {} };

export type EncounterState = "planned" | "arrived" | "triaged" | "in-progress" | "finished" | "cancelled" | "entered-in-error";
export type EncounterEvent = "arrive" | "triage" | "start" | "finish" | "cancel" | "markError";
export const ENCOUNTER: Table<EncounterState, EncounterEvent> = {
  planned: { arrive: "arrived", cancel: "cancelled", markError: "entered-in-error" },
  arrived: { triage: "triaged", start: "in-progress", cancel: "cancelled", markError: "entered-in-error" },
  triaged: { start: "in-progress", cancel: "cancelled", markError: "entered-in-error" },
  "in-progress": { finish: "finished", markError: "entered-in-error" },
  finished: { markError: "entered-in-error" },
  cancelled: {},
  "entered-in-error": {},
};

/* AllergyIntolerance (ADR 0004): never deleted or edited; a wrong entry is marked entered-in-error with a reason and a
   correct one is recorded as a new row. Only `active` allergies feed the prescription check. */
export type AllergyState = "active" | "entered-in-error";
export type AllergyEvent = "markError";
export const ALLERGY: Table<AllergyState, AllergyEvent> = { active: { markError: "entered-in-error" }, "entered-in-error": {} };

export type BedState ="vacant" | "reserved" | "occupied" | "discharge-pending" | "cleaning" | "blocked";
export type BedEvent = "reserve" | "occupy" | "release" | "startDischarge" | "leave" | "markReady" | "block" | "unblock";
export const BED: Table<BedState, BedEvent> = {
  vacant: { reserve: "reserved", occupy: "occupied", block: "blocked" },
  reserved: { occupy: "occupied", release: "vacant" },
  occupied: { startDischarge: "discharge-pending" },
  "discharge-pending": { leave: "cleaning" },
  cleaning: { markReady: "vacant" },
  blocked: { unblock: "vacant" },
};

/* Discharge: final bill cannot be settled before pharmacy clearance (walkthrough B9/B10). */
export type DischargeState = "initiated" | "summary-signed" | "pharmacy-cleared" | "final-bill" | "paid" | "left";
export type DischargeEvent = "signSummary" | "clearPharmacy" | "finalBill" | "pay" | "leave";
export const DISCHARGE: Table<DischargeState, DischargeEvent> = {
  initiated: { signSummary: "summary-signed" },
  "summary-signed": { clearPharmacy: "pharmacy-cleared" },
  "pharmacy-cleared": { finalBill: "final-bill" },
  "final-bill": { pay: "paid" },
  paid: { leave: "left" },
  left: {},
};

export type DoseState = "scheduled" | "due" | "given" | "held" | "refused" | "missed";
export type DoseEvent = "becomeDue" | "give" | "hold" | "refuse" | "miss";
export const MAR_DOSE: Table<DoseState, DoseEvent> = {
  scheduled: { becomeDue: "due" },
  due: { give: "given", hold: "held", refuse: "refused", miss: "missed" },
  given: {}, held: {}, refused: {}, missed: {},
};

export type EscalationState = "raised" | "doctor-informed" | "resolved";
export type EscalationEvent = "inform" | "resolve";
export const ESCALATION: Table<EscalationState, EscalationEvent> = { raised: { inform: "doctor-informed" }, "doctor-informed": { resolve: "resolved" }, resolved: {} };

export type ConsentState = "proposed" | "active" | "revoked" | "expired" | "ended" | "reviewed";
export type ConsentEvent = "activate" | "revoke" | "expire" | "end" | "review";
export const CONSENT: Table<ConsentState, ConsentEvent> = {
  proposed: { activate: "active" },
  active: { revoke: "revoked", expire: "expired", end: "ended" },
  revoked: {}, expired: {},
  ended: { review: "reviewed" },
  reviewed: {},
};

/* Claim: 3 wrong codes → locked for 24 h (round-2 fix #3). The counter lives on the claim row. */
export type ClaimState = "candidate" | "proof-pending" | "linked" | "not-mine" | "locked";
export type ClaimEvent = "startProof" | "codeOk" | "codeWrong" | "thirdWrong" | "notMine" | "unlock";
export const CLAIM: Table<ClaimState, ClaimEvent> = {
  candidate: { startProof: "proof-pending", notMine: "not-mine" },
  "proof-pending": { codeOk: "linked", codeWrong: "proof-pending", thirdWrong: "locked", notMine: "not-mine" },
  linked: {}, "not-mine": {},
  locked: { unlock: "proof-pending" },
};
export const CLAIM_MAX_TRIES = 3;
export const CLAIM_LOCK_HOURS = 24;

export type ShiftState = "open" | "counted" | "closed" | "approved";
export type ShiftEvent = "count" | "close" | "approve" | "recount";
export const SHIFT: Table<ShiftState, ShiftEvent> = { open: { count: "counted" }, counted: { close: "closed", recount: "open" }, closed: { approve: "approved", recount: "open" }, approved: {} };

export type SyncState = "local" | "pending" | "confirmed" | "conflict" | "failed-retry";
export type SyncEvent = "queue" | "ack" | "conflict" | "fail" | "retry" | "resolve";
export const SYNC: Table<SyncState, SyncEvent> = {
  local: { queue: "pending" },
  pending: { ack: "confirmed", conflict: "conflict", fail: "failed-retry" },
  confirmed: {},
  conflict: { resolve: "pending" },
  "failed-retry": { retry: "pending" },
};
