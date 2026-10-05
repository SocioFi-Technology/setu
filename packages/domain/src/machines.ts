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
  /* ADR 0006 addendum: withdrawing a test's results rejects the tube it was measured in (reason results-withdrawn). */
  done: { reject: "rejected" },
  rejected: {},
};

/* Result (lab Observation), ADR 0006: technical verify and clinical validation are separate steps (two people unless the
   facility allows one); a critical (HH/LL) result needs a logged call-back before `validate` — enforced in
   @setu/domain lab.ts validateBlockers and the route, not here. A correction never edits a row: the old one is marked
   entered-in-error and a new row starts again at preliminary. `amend` stays from the domain model, unused by the lab. */
export type ResultState = "registered" | "preliminary" | "verified" | "final" | "amended" | "entered-in-error";
export type ResultEvent = "enter" | "verify" | "validate" | "return" | "amend" | "markError";
export const RESULT: Table<ResultState, ResultEvent> = {
  registered: { enter: "preliminary" },
  preliminary: { verify: "verified", markError: "entered-in-error" },
  /* ADR 0006 addendum (decision 119): the pathologist sends a verified test back to the technologist. */
  verified: { validate: "final", return: "preliminary", markError: "entered-in-error" },
  final: { amend: "amended", markError: "entered-in-error" },
  amended: { amend: "amended", markError: "entered-in-error" },
  "entered-in-error": {},
};

/* Lab report version (DiagnosticReport), ADR 0006: a version exists only once released (an immutable snapshot); its
   status is chosen at release (lab.ts releaseStatus); releasing the next version supersedes it. */
export type LabReportState = "preliminary" | "final" | "corrected" | "superseded";
export type LabReportEvent = "supersede";
export const LAB_REPORT: Table<LabReportState, LabReportEvent> = {
  preliminary: { supersede: "superseded" },
  final: { supersede: "superseded" },
  corrected: { supersede: "superseded" },
  superseded: {},
};

/* Communication (SMS, patient app, doctor's inbox), ADR 0006: a retry re-queues the same row (same message id). */
export type CommunicationState = "preparation" | "in-progress" | "completed" | "failed";
export type CommunicationEvent = "send" | "deliver" | "fail" | "retry";
export const COMMUNICATION: Table<CommunicationState, CommunicationEvent> = {
  preparation: { send: "in-progress" },
  "in-progress": { deliver: "completed", fail: "failed" },
  completed: {},
  failed: { retry: "preparation" },
};

/* Doctor's inbox item (a doctor-inbox Communication row), ADR 0007: the recipient acknowledges it once ("Seen", or "Seen
   + tell patient"). Stored as an append-only InboxAck row — the Communication itself is never edited. */
export type InboxItemState = "unread" | "acknowledged";
export type InboxItemEvent = "acknowledge";
export const INBOX_ITEM: Table<InboxItemState, InboxItemEvent> = { unread: { acknowledge: "acknowledged" }, acknowledged: {} };

/* ADR 0005: a draft or issued bill (no confirmed money) can be marked entered-in-error (void, owner/admin, reason);
   `cancel` stays in the table from the domain model but no route uses it yet. ADR 0013 addendum: a partially-paid or
   balanced bill can be voided once every paisa of it was refunded (`voidBlockers` guards that, the database too). */
export type InvoiceState = "draft" | "issued" | "partially-paid" | "balanced" | "cancelled" | "entered-in-error";
export type InvoiceEvent = "issue" | "payPart" | "payAll" | "cancel" | "markError";
export const INVOICE: Table<InvoiceState, InvoiceEvent> = {
  draft: { issue: "issued", cancel: "cancelled", markError: "entered-in-error" },
  issued: { payPart: "partially-paid", payAll: "balanced", cancel: "cancelled", markError: "entered-in-error" },
  "partially-paid": { payPart: "partially-paid", payAll: "balanced", cancel: "cancelled", markError: "entered-in-error" },
  balanced: { markError: "entered-in-error" },
  cancelled: {},
  "entered-in-error": {},
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

/* ADR 0013: a refund of money confirmed on one bill. Nothing moves before `approve`; `pay` when every allocation was
   paid out; `withdraw` = an approved refund that will not be paid (owner / admin, note) — never shown as rejected. */
export type RefundState = "requested" | "approved" | "paid" | "rejected" | "withdrawn";
export type RefundEvent = "approve" | "reject" | "pay" | "withdraw";
export const REFUND: Table<RefundState, RefundEvent> = {
  requested: { approve: "approved", reject: "rejected" },
  approved: { pay: "paid", withdraw: "withdrawn" },
  paid: {},
  rejected: {},
  withdrawn: {},
};

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

/* ADR 0014: `vacate` = a transfer out (leg 2 of a two-leg bed move frees the source bed into cleaning); `release`
   gives back a reservation that was never occupied. Block / unblock and mark-ready are ward actions. */
export type BedState ="vacant" | "reserved" | "occupied" | "discharge-pending" | "cleaning" | "blocked";
export type BedEvent = "reserve" | "occupy" | "release" | "vacate" | "startDischarge" | "leave" | "markReady" | "block" | "unblock";
export const BED: Table<BedState, BedEvent> = {
  vacant: { reserve: "reserved", occupy: "occupied", block: "blocked" },
  reserved: { occupy: "occupied", release: "vacant" },
  occupied: { startDischarge: "discharge-pending", vacate: "cleaning" },
  "discharge-pending": { leave: "cleaning" },
  cleaning: { markReady: "vacant" },
  blocked: { unblock: "vacant" },
};

/* ADR 0014 (review): an admission request (the ER's admit disposition) is completed by the desk or cancelled; a bed
   assignment (one leg of a move) is reserved, then occupied, and ends once — never deleted. */
export type AdmissionState = "requested" | "admitted" | "cancelled";
export type AdmissionEvent = "admit" | "cancel";
export const ADMISSION: Table<AdmissionState, AdmissionEvent> = { requested: { admit: "admitted", cancel: "cancelled" }, admitted: {}, cancelled: {} };
export type BedAssignmentState = "reserved" | "occupied" | "ended";
export type BedAssignmentEvent = "occupy" | "end";
export const BED_ASSIGNMENT: Table<BedAssignmentState, BedAssignmentEvent> = { reserved: { occupy: "occupied", end: "ended" }, occupied: { end: "ended" }, ended: {} };

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

/* ADR 0009 (pharmacy purchasing and counts). A purchase order is sent (above the threshold only with the owner's /
   admin's approval), received in one or more goods receipts, closed short when the rest will not come, or cancelled
   before anything arrives. A goods receipt is checked, then posted (stock in). A count is submitted and changes stock
   only when the owner / admin approves it. */
export type PurchaseOrderState = "draft" | "sent" | "partially-received" | "received" | "cancelled";
export type PurchaseOrderEvent = "send" | "receivePart" | "receiveAll" | "closeShort" | "cancel";
export const PURCHASE_ORDER: Table<PurchaseOrderState, PurchaseOrderEvent> = {
  draft: { send: "sent", cancel: "cancelled" },
  sent: { receivePart: "partially-received", receiveAll: "received", cancel: "cancelled" },
  "partially-received": { receivePart: "partially-received", receiveAll: "received", closeShort: "received" },
  received: {},
  cancelled: {},
};
export type GoodsReceiptState = "checking" | "posted" | "discarded";
export type GoodsReceiptEvent = "post" | "discard";
export const GOODS_RECEIPT: Table<GoodsReceiptState, GoodsReceiptEvent> = { checking: { post: "posted", discard: "discarded" }, posted: {}, discarded: {} };
export type StockCountState = "counting" | "submitted" | "approved" | "rejected";
export type StockCountEvent = "submit" | "approve" | "reject";
export const STOCK_COUNT: Table<StockCountState, StockCountEvent> = { counting: { submit: "submitted" }, submitted: { approve: "approved", reject: "rejected" }, approved: {}, rejected: {} };

export type SyncState = "local" | "pending" | "confirmed" | "conflict" | "failed-retry";
export type SyncEvent = "queue" | "ack" | "conflict" | "fail" | "retry" | "resolve";
export const SYNC: Table<SyncState, SyncEvent> = {
  local: { queue: "pending" },
  pending: { ack: "confirmed", conflict: "conflict", fail: "failed-retry" },
  confirmed: {},
  conflict: { resolve: "pending" },
  "failed-retry": { retry: "pending" },
};
