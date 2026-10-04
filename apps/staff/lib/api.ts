import type {
  FacilityView, FacilityUpdate, SettingsUpdate, UserList, UserView, UserCreate, UserCredentialResponse, PriceList, PriceCreate, PriceHistory, AuditPage, AuditQuery,
  DispenseQueue, DispenseRequest, DispenseView, OtcCreateRequest, OtcView, RxPhotoRequest, StockList, SupplierList, SupplierLedger, SupplierPaymentRequest,
  PurchaseOrderList, PurchaseOrderView, GoodsReceiptView, GrnLineRequest, StockCountView, CountList, PharmacyApprovals, TransferRequest,
  CountShiftRequest, DashboardView, DrillView, MyShiftResponse, ShiftList, ShiftView,
  AckResponse, DocPrintRequest, DocPrintResponse, DocPrintView, InboxView, LrVerifyResponse, RxVerifyResponse,
  CallbackRequest, LabReportView, LabVisitView, LabWorklist, ResultEntryRequest, RevokeResponse, SpecimenRejectRequest,
  ApprovalDecisionResponse, ApprovalList, ReconcileDecisionResponse, ReconcileList, BillingWorklist, ChargeDefinitionList, DiscountRequest, DiscountResponse, InvoiceView, NewPaymentRequest, PaymentResponse, PrintRequest, PrintResponse, ReceiptList, ReceiptView, VerifyResponse, PayResultView,
  AiDraftResponse, AllergyOptions, AllergyView, CompositionView, ConsultationView, ConsultWorklist, Icd11Search, MedicineSearch, RecordAllergyRequest, SaveDraftRequest, SignRequest, TestList,
  ApiError, Capabilities, VitalsBatchRequest, VitalsBatchResponse, VitalsView, VitalsWorklist, CreateVisitResponse, MatchDecisionResponse, MatchPreviewResponse, Me, PatientMatches, PatientSearchResponse, QueueItem, QueueResponse, RegisterResponse, RegistrationInput, ReviewOutcomeResponse, ReviewQueueResponse,
} from "@setu/contracts";
import { clearDraftsForOwner, clearRefusedForOwner, enqueue, flush } from "./outbox";
export class ApiFailure extends Error { constructor(public status: number, public body: ApiError) { super(body.message_en); } }
/** ADR 0010: the server said this session has ended (switched off, role or password changed) — the sign-in page says why. */
let sessionEnded = false;
export const wasSessionEnded = () => sessionEnded;

async function call<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
  const r = await fetch("/api" + path, {
    method, credentials: "include",
    // Only a request with a body says it is JSON: an empty JSON body is refused by the API (hands-on test 02/10/2026: sign-out).
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(idemKey ? { "idempotency-key": idemKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let e: ApiError = { code: "http_" + r.status, message_bn: "সার্ভারে সমস্যা", message_en: r.statusText }; try { e = await r.json(); } catch {}
    // ADR 0010: switched off, the role changed or the password reset — this session has ended: back to sign-in, saying why
    if (r.status === 401 && e.code === "session_ended") sessionEnded = true;
    if (r.status === 401 && e.code === "session_ended" && typeof location !== "undefined" && location.pathname !== "/login") {
      // the same clean-up as signing out: nothing of this user's left on a shared device (screen review)
      clearRefusedForOwner(); clearDraftsForOwner();
      fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" }).catch(() => {}).finally(() => { location.href = "/login?ended=1"; });
    }
    throw new ApiFailure(r.status, e);
  }
  return r.json() as Promise<T>;
}
/** A write: online it goes straight to the server; offline (or when the network drops) it waits in the outbox with the
    same Idempotency-Key and the caller gets { queued: true } — never a success. */
export type Write<T> = { queued: false; data: T } | { queued: true };
async function write<T>(method: string, path: string, body: unknown, label: string, key: string = crypto.randomUUID()): Promise<Write<T>> {
  const park = (): Write<T> => {
    if (enqueue({ method, path, body, key, label })) return { queued: true };
    throw new ApiFailure(0, { code: "offline", message_bn: "সংযোগ নেই — সংরক্ষণ হয়নি", message_en: "Offline — not saved" });
  };
  if (typeof navigator !== "undefined" && !navigator.onLine) return park();
  try { void flush(); return { queued: false, data: await call<T>(method, path, body, key) }; }
  catch (e) { if (e instanceof ApiFailure) throw e; return park(); }
}

export const fd = {
  search: (q: string) => call<PatientSearchResponse>("GET", "/v1/patients/search?q=" + encodeURIComponent(q)),
  matches: (id: string) => call<PatientMatches>("GET", `/v1/patients/${encodeURIComponent(id)}/matches`),
  preview: (draft: RegistrationInput) => call<MatchPreviewResponse>("POST", "/v1/patients/match-preview", draft),
  decide: (id: string, body: { decision: "link" | "linkAnyway" | "review" | "different"; candidateId?: string; reason?: string }) =>
    call<MatchDecisionResponse>("POST", `/v1/patients/${encodeURIComponent(id)}/match-decisions`, body, crypto.randomUUID()),
  undo: (id: string, reason?: string) => call<MatchDecisionResponse>("POST", `/v1/patients/${encodeURIComponent(id)}/match-decisions/undo`, reason ? { reason } : {}, crypto.randomUUID()),
  /** `key`: one per filled-in form, so pressing Save twice (or offline, then online) never registers twice. */
  register: (body: RegistrationInput & { createVisit: boolean }, key: string) => write<RegisterResponse>("POST", "/v1/patients", body, "register", key),
  createVisit: (patientId: string) => write<CreateVisitResponse>("POST", "/v1/encounters", { patientId }, "visit"),
  queue: () => call<QueueResponse>("GET", "/v1/queue"),
  reviews: () => call<ReviewQueueResponse>("GET", "/v1/reviews/duplicates"),
  unlink: (id: string, reason: string) => call<ReviewOutcomeResponse>("POST", `/v1/patients/${encodeURIComponent(id)}/unlink`, { reason }, crypto.randomUUID()),
  keep: (taskId: string) => call<ReviewOutcomeResponse>("POST", `/v1/reviews/${encodeURIComponent(taskId)}/keep`, {}, crypto.randomUUID()),
  act: (id: string, action: "next" | "noShow" | "call") => call<QueueItem>("POST", `/v1/encounters/${encodeURIComponent(id)}/actions`, { action }, crypto.randomUUID()),
};

/* Vitals (slice A4). `key`: one per filled-in form, so Save twice (or offline, then online) never stores twice. */
export const vitals = {
  worklist: () => call<VitalsWorklist>("GET", "/v1/vitals/worklist"),
  view: (encounterId: string) => call<VitalsView>("GET", `/v1/encounters/${encodeURIComponent(encounterId)}/vitals`),
  record: (encounterId: string, body: VitalsBatchRequest, key: string) => write<VitalsBatchResponse>("POST", `/v1/encounters/${encodeURIComponent(encounterId)}/vitals`, body, "vitals", key),
};

/* Consultation (slice A5). Every write waits for the server: a note is Signed only when `sign` answers 200 — there is no
   client-side "signed" and no offline signing (decision 25). Draft saves that cannot reach the server are kept by the
   screen as a device draft (outbox.ts `saveDeviceDraft`), never queued as a blind replay. `key`: the caller's
   Idempotency-Key, so a retry (e.g. the right PIN after a wrong one) is the same request. */
const enc = encodeURIComponent;
export const cons = {
  worklist: () => call<ConsultWorklist>("GET", "/v1/consultations/worklist"),
  view: (encounterId: string) => call<ConsultationView>("GET", `/v1/encounters/${enc(encounterId)}/consultation`),
  open: (encounterId: string) => call<ConsultationView>("POST", `/v1/encounters/${enc(encounterId)}/consultation/open`, {}, crypto.randomUUID()),
  save: (compositionId: string, body: SaveDraftRequest, key: string) => call<CompositionView>("PUT", `/v1/compositions/${enc(compositionId)}`, body, key),
  sign: (compositionId: string, body: SignRequest, key: string) => call<ConsultationView>("POST", `/v1/compositions/${enc(compositionId)}/sign`, body, key),
  amend: (compositionId: string, reason: string) => call<ConsultationView>("POST", `/v1/compositions/${enc(compositionId)}/amend`, { reason }, crypto.randomUUID()),
  aiDraft: (compositionId: string, kind: "previsit" | "note") => call<AiDraftResponse>("POST", `/v1/compositions/${enc(compositionId)}/ai-draft`, { kind }, crypto.randomUUID()),
  recordAllergy: (patientId: string, body: RecordAllergyRequest, key: string) => call<AllergyView>("POST", `/v1/patients/${enc(patientId)}/allergies`, body, key),
  markAllergyError: (allergyId: string, encounterId: string, reason: string, key: string) => call<AllergyView>("POST", `/v1/allergies/${enc(allergyId)}/entered-in-error`, { encounterId, reason }, key),
  icd11: (q: string) => call<Icd11Search>("GET", "/v1/catalog/icd11?q=" + enc(q)),
  medicines: (q: string) => call<MedicineSearch>("GET", "/v1/catalog/medicines?q=" + enc(q)),
  tests: () => call<TestList>("GET", "/v1/catalog/tests"),
  allergyOptions: () => call<AllergyOptions>("GET", "/v1/catalog/allergy-options"),
};

/* Billing (slice A6–A7). Bill edits, discounts, issuing and approvals need the server (they are refused offline, like
   signing): nothing is "applied" or "issued" on this device. Payments go through the outbox: offline, cash is
   "recorded on this device · not synced" and a payment link "will send when online" — never Paid until the server
   confirms. `key`: the caller's Idempotency-Key, so pressing a button twice is one request. */
export const bill = {
  worklist: () => call<BillingWorklist>("GET", "/v1/billing/worklist"),
  definitions: (q: string) => call<ChargeDefinitionList>("GET", "/v1/charge-definitions?q=" + enc(q)),
  open: (encounterId: string) => call<InvoiceView>("POST", `/v1/encounters/${enc(encounterId)}/invoice`, {}, crypto.randomUUID()),
  view: (id: string) => call<InvoiceView>("GET", `/v1/invoices/${enc(id)}`),
  addLine: (id: string, code: string, rev: number) => call<InvoiceView>("POST", `/v1/invoices/${enc(id)}/lines`, { code, qty: 1, rev }, crypto.randomUUID()),
  setQty: (id: string, lineId: string, qty: number, rev: number) => call<InvoiceView>("POST", `/v1/invoices/${enc(id)}/lines/${enc(lineId)}/qty`, { qty, rev }, crypto.randomUUID()),
  removeLine: (id: string, lineId: string, rev: number) => call<InvoiceView>("POST", `/v1/invoices/${enc(id)}/lines/${enc(lineId)}/remove`, { rev }, crypto.randomUUID()),
  discount: (id: string, body: DiscountRequest, key: string) => call<DiscountResponse>("POST", `/v1/invoices/${enc(id)}/discount`, body, key),
  removeDiscount: (id: string, rev: number) => call<InvoiceView>("POST", `/v1/invoices/${enc(id)}/discount/remove`, { rev }, crypto.randomUUID()),
  issue: (id: string, rev: number, key: string) => call<InvoiceView>("POST", `/v1/invoices/${enc(id)}/issue`, { rev }, key),
  approvals: (status: "requested" | "approved" | "rejected") => call<ApprovalList>("GET", "/v1/approvals?status=" + status),
  decide: (taskId: string, decision: "approve" | "reject", note: string, key: string) => call<ApprovalDecisionResponse>("POST", `/v1/approvals/${enc(taskId)}/${decision}`, note ? { note } : {}, key),
  pay: (id: string, body: NewPaymentRequest, key: string) => write<PaymentResponse>("POST", `/v1/invoices/${enc(id)}/payments`, body, "payment", key),
  cancel: (paymentId: string) => call<PaymentResponse>("POST", `/v1/payments/${enc(paymentId)}/cancel`, {}, crypto.randomUUID()),
  retry: (paymentId: string) => call<PaymentResponse>("POST", `/v1/payments/${enc(paymentId)}/retry`, {}, crypto.randomUUID()),
  /** ADR 0012: a new SMS with the current payment link */
  sendSms: (paymentId: string) => call<PaymentResponse>("POST", `/v1/payments/${enc(paymentId)}/send-sms`, {}, crypto.randomUUID()),
  verifyTrx: (paymentId: string, trxId: string) => call<PaymentResponse>("POST", `/v1/payments/${enc(paymentId)}/verify-trx`, { trxId }, crypto.randomUUID()),
  /** dev and tests only: the fake gateway plays the customer (the API refuses it with a real provider or in production) */
  fake: (paymentId: string, kind: "opened" | "confirmed" | "failed", deliver = true) => call<{ delivered: boolean; trxId?: string; outcome?: string }>("POST", `/v1/dev/fake-payments/${enc(paymentId)}/${kind}`, { deliver }),
  notBilled: (id: string, lineId: string, reason: string, rev: number, key: string) => call<InvoiceView>("POST", `/v1/invoices/${enc(id)}/lines/${enc(lineId)}/not-billed`, { reason, rev }, key),
  refreshOrders: (id: string, rev: number) => call<InvoiceView>("POST", `/v1/invoices/${enc(id)}/refresh-orders`, { rev }, crypto.randomUUID()),
  void: (id: string, reason: string, key: string) => call<InvoiceView>("POST", `/v1/invoices/${enc(id)}/void`, { reason }, key),
  reconciliation: (status: "requested" | "approved" | "rejected") => call<ReconcileList>("GET", "/v1/reconciliation?status=" + status),
  reconcile: (taskId: string, action: "apply" | "resolve", note: string, key: string) => call<ReconcileDecisionResponse>("POST", `/v1/reconciliation/${enc(taskId)}/${action}`, note ? { note } : {}, key),
  receipts: (invoiceId: string) => call<ReceiptList>("GET", `/v1/invoices/${enc(invoiceId)}/receipts`),
  makeReceipt: (invoiceId: string, key: string) => call<ReceiptView>("POST", `/v1/invoices/${enc(invoiceId)}/receipts`, {}, key),
  receipt: (id: string) => call<ReceiptView>("GET", `/v1/receipts/${enc(id)}`),
  print: (id: string, body: PrintRequest, key: string) => call<PrintResponse>("POST", `/v1/receipts/${enc(id)}/print`, body, key),
  verify: (code: string) => call<VerifyResponse>("GET", `/v1/verify/rc/${enc(code)}`),
  /** ADR 0011: the patient's payment result page (no login) */
  payResult: (code: string) => call<PayResultView>("GET", `/v1/pay/${enc(code)}/result`),
};

/* Lab (slice A8–A11, ADR 0006). Collect / receive / start / reject go through the outbox when offline (decision D8):
   the tube shows "Not yet synced" until the server answers. Results, verify, validate, call-backs, release and sending
   need the server — nothing is verified, validated, released or sent on this device. `key`: the caller's
   Idempotency-Key, so pressing a button twice (or a PIN retry) is one request. */
type LabStage = LabWorklist["stage"];
export const lab = {
  worklist: (stage: LabStage) => call<LabWorklist>("GET", "/v1/lab/worklist?stage=" + stage),
  visit: (encounterId: string) => call<LabVisitView>("GET", `/v1/lab/visits/${enc(encounterId)}`),
  report: (id: string) => call<LabReportView>("GET", `/v1/lab/reports/${enc(id)}`),
  labels: (encounterId: string, key: string) => call<LabVisitView>("POST", `/v1/lab/visits/${enc(encounterId)}/labels`, {}, key),
  step: (specimenId: string, step: "collect" | "receive" | "start", key: string) => write<LabVisitView>("POST", `/v1/lab/specimens/${enc(specimenId)}/${step}`, { at: new Date().toISOString() }, `lab_${step}`, key),
  reject: (specimenId: string, body: Omit<SpecimenRejectRequest, "at">, key: string) => write<LabVisitView>("POST", `/v1/lab/specimens/${enc(specimenId)}/reject`, { ...body, at: new Date().toISOString() }, "lab_reject", key),
  results: (orderId: string, body: ResultEntryRequest, key: string) => call<LabVisitView>("POST", `/v1/lab/orders/${enc(orderId)}/results`, body, key),
  correct: (observationId: string, body: { value: string; confirm?: string; reason: string }, key: string) => call<LabVisitView>("POST", `/v1/lab/observations/${enc(observationId)}/correct`, body, key),
  verify: (encounterId: string, body: { pin: string; observationIds: string[]; deltaChecked: boolean }, key: string) => call<LabVisitView>("POST", `/v1/lab/visits/${enc(encounterId)}/verify`, body, key),
  validate: (encounterId: string, body: { pin: string; observationIds: string[] }, key: string) => call<LabVisitView>("POST", `/v1/lab/visits/${enc(encounterId)}/validate`, body, key),
  callback: (observationId: string, body: CallbackRequest, key: string) => call<LabVisitView>("POST", `/v1/lab/observations/${enc(observationId)}/callbacks`, body, key),
  sendBack: (orderId: string, reason: string, key: string) => call<LabVisitView>("POST", `/v1/lab/orders/${enc(orderId)}/return`, { reason }, key),
  withdraw: (orderId: string, reason: string, key: string) => call<LabVisitView>("POST", `/v1/lab/orders/${enc(orderId)}/withdraw`, { reason }, key),
  release: (encounterId: string, observationIds: string[], key: string) => call<LabVisitView>("POST", `/v1/lab/visits/${enc(encounterId)}/release`, { observationIds }, key),
  send: (reportId: string, channel: "sms" | "patient-app", key: string) => call<LabVisitView>("POST", `/v1/lab/reports/${enc(reportId)}/send`, { channel }, key),
  retry: (communicationId: string, key: string) => call<LabVisitView>("POST", `/v1/lab/communications/${enc(communicationId)}/retry`, {}, key),
  revoke: (orderId: string, reason: string, key: string) => call<RevokeResponse>("POST", `/v1/orders/${enc(orderId)}/revoke`, { reason }, key),
  /** dev and tests only: the fake SMS gateway fails the next send (the API refuses it with a real gateway or in production) */
  failNextSms: () => call<{ failing: number }>("POST", "/v1/dev/fake-messenger/fail-next", { n: 1 }),
};

/* Doctor's inbox and printed documents (slice A12–A13, ADR 0007). An acknowledgement made offline waits in the outbox
   with its Idempotency-Key and the screen says "Acknowledged — not yet synced"; nothing is sent to the patient until
   the server has stored it. Printing needs the server (the PDF is rendered and logged there). */
export type DocKindT = "rx" | "lr";
export const doctor = {
  inbox: (days = 14) => call<InboxView>("GET", `/v1/doctor/inbox?days=${days}`),
  ack: (id: string, notifyPatient: boolean, key: string) => write<AckResponse>("POST", `/v1/doctor/inbox/${enc(id)}/ack`, { notifyPatient }, "inbox_ack", key),
};
export const docs = {
  view: (kind: DocKindT, id: string) => call<DocPrintView>("GET", `/v1/documents/${kind}/${enc(id)}/print`),
  print: (kind: DocKindT, id: string, body: DocPrintRequest, key: string) => call<DocPrintResponse>("POST", `/v1/documents/${kind}/${enc(id)}/print`, body, key),
  /** a browser URL (same origin, through the /api proxy) */
  previewSrc: (kind: DocKindT, id: string, format: "a5" | "a4", lang: "both" | "bn" | "en") => `/api/v1/documents/${kind}/${enc(id)}/preview?format=${format}&lang=${lang}`,
  pdfSrc: (pdfUrl: string) => `/api${pdfUrl}`,
  verifyRx: (code: string) => call<RxVerifyResponse>("GET", `/v1/verify/rx/${enc(code)}`),
  verifyLr: (code: string) => call<LrVerifyResponse>("GET", `/v1/verify/lr/${enc(code)}`),
};

/* Shift close and the owner dashboard (slice C1–C4, ADR 0008). Opening, counting and reviewing need the server (the
   drawer's expected cash is the server's figure); nothing is "handed over" or "approved" until it answers. */
export const shifts = {
  mine: () => call<MyShiftResponse>("GET", "/v1/shifts/mine"),
  open: (openingFloatPaisa: number, key: string) => call<ShiftView>("POST", "/v1/shifts", { openingFloatPaisa }, key),
  count: (id: string, body: CountShiftRequest, key: string) => call<ShiftView>("POST", `/v1/shifts/${enc(id)}/count`, body, key),
  list: (status: "closed" | "open" | "approved" | "all" = "closed") => call<ShiftList>("GET", `/v1/shifts?status=${status}`),
  view: (id: string) => call<ShiftView>("GET", `/v1/shifts/${enc(id)}`),
  review: (id: string, decision: "approve" | "recount", note: string, key: string) => call<ShiftView>("POST", `/v1/shifts/${enc(id)}/review`, { decision, ...(note ? { note } : {}) }, key),
};
export const owner = {
  dashboard: (period: "today" | "7d" | "30d") => call<DashboardView>("GET", `/v1/owner/dashboard?period=${period}`),
  drill: (period: "today" | "7d" | "30d", what: DrillView["what"]) => call<DrillView>("GET", `/v1/owner/drill?period=${period}&what=${what}`),
};

export const api = {
  health: () => call<{ ok: true; version: string; db: string }>("GET", "/health"),
  login: (identifier: string, password: string, demoPlan?: string) => call<Me>("POST", "/v1/auth/login", { identifier, password, ...(demoPlan ? { demoPlan } : {}) }),
  logout: () => call<{ ok: true }>("POST", "/v1/auth/logout"),
  me: () => call<Me>("GET", "/v1/me"),
  capabilities: () => call<Capabilities>("GET", "/v1/me/capabilities"),
  pinVerify: (pin: string) => call<{ ok: boolean; triesLeft?: number; lockedUntil?: string }>("POST", "/v1/auth/pin/verify", { pin }),
  /** ADR 0010: the first sign-in with a one-time password sets the user's own password and PIN */
  firstSignIn: (password: string, pin: string) => call<Me>("POST", "/v1/auth/first-sign-in", { password, pin }),
};

/* Pharmacy (phase 2 slice 2, ADR 0009). Dispensing, sales, purchasing and counts move stock and money, so they need the
   server: no offline queue — the screen says so and the buttons wait for a connection. */
const k = () => crypto.randomUUID();
export const pharm = {
  queue: () => call<DispenseQueue>("GET", "/v1/pharmacy/queue"),
  visit: (encounterId: string) => call<DispenseView>("GET", `/v1/pharmacy/encounters/${enc(encounterId)}`),
  dispense: (encounterId: string, body: DispenseRequest, key: string) => call<DispenseView>("POST", `/v1/pharmacy/encounters/${enc(encounterId)}/dispense`, body, key),
  labels: (encounterId: string, requestIds: string[], key: string) => call<{ printedAt: string; labels: number }>("POST", `/v1/pharmacy/encounters/${enc(encounterId)}/labels/print`, { requestIds }, key),
  decline: (encounterId: string, body: { compositionId: string; requestId: string; reason: string }, key: string) => call<DispenseView>("POST", `/v1/pharmacy/encounters/${enc(encounterId)}/decline`, body, key),
  otcNew: (body: OtcCreateRequest, key: string) => call<OtcView>("POST", "/v1/pharmacy/otc", body, key),
  otc: (id: string) => call<OtcView>("GET", `/v1/pharmacy/otc/${enc(id)}`),
  otcAdd: (id: string, body: { rev: number; medicineKey: string; qty: number }) => call<OtcView>("POST", `/v1/pharmacy/otc/${enc(id)}/lines`, body, k()),
  otcRemove: (id: string, lineId: string, rev: number) => call<OtcView>("POST", `/v1/pharmacy/otc/${enc(id)}/lines/${enc(lineId)}/remove`, { rev }, k()),
  otcPhoto: (id: string, body: RxPhotoRequest) => call<OtcView>("POST", `/v1/pharmacy/otc/${enc(id)}/rx-photo`, body, k()),
  otcPhotoSrc: (id: string) => `/api/v1/pharmacy/otc/${enc(id)}/rx-photo`,
  otcIssue: (id: string, rev: number, key: string) => call<OtcView>("POST", `/v1/pharmacy/otc/${enc(id)}/issue`, { rev }, key),
  stock: (q: string, filter: "all" | "near-expiry" | "expired" | "low") => call<StockList>("GET", `/v1/pharmacy/stock?q=${enc(q)}&filter=${filter}`),
  transfer: (body: TransferRequest, key: string) => call<{ from: string; to: string }>("POST", "/v1/pharmacy/transfers", body, key),
};
export const purch = {
  suppliers: () => call<SupplierList>("GET", "/v1/pharmacy/suppliers"),
  supplier: (id: string) => call<SupplierLedger>("GET", `/v1/pharmacy/suppliers/${enc(id)}`),
  newSupplier: (body: { name: string; phone?: string }) => call<SupplierLedger>("POST", "/v1/pharmacy/suppliers", body, k()),
  pay: (id: string, body: SupplierPaymentRequest, key: string) => call<SupplierLedger>("POST", `/v1/pharmacy/suppliers/${enc(id)}/payments`, body, key),
  orders: (status?: string) => call<PurchaseOrderList>("GET", "/v1/pharmacy/purchase-orders" + (status ? `?status=${status}` : "")),
  order: (id: string) => call<PurchaseOrderView>("GET", `/v1/pharmacy/purchase-orders/${enc(id)}`),
  newOrder: (supplierId: string, key: string) => call<PurchaseOrderView>("POST", "/v1/pharmacy/purchase-orders", { supplierId }, key),
  addLine: (id: string, body: { rev: number; medicineKey: string; qty: number; costPaisa: number }) => call<PurchaseOrderView>("POST", `/v1/pharmacy/purchase-orders/${enc(id)}/lines`, body, k()),
  removeLine: (id: string, lineId: string, rev: number) => call<PurchaseOrderView>("POST", `/v1/pharmacy/purchase-orders/${enc(id)}/lines/${enc(lineId)}/remove`, { rev }, k()),
  send: (id: string, rev: number, key: string) => call<PurchaseOrderView>("POST", `/v1/pharmacy/purchase-orders/${enc(id)}/send`, { rev }, key),
  approval: (id: string, decision: "approve" | "reject", note: string, key: string) => call<PurchaseOrderView>("POST", `/v1/pharmacy/purchase-orders/${enc(id)}/approval`, note ? { decision, note } : { decision }, key),
  end: (id: string, how: "cancel" | "close-short", rev: number, reason: string, key: string) => call<PurchaseOrderView>("POST", `/v1/pharmacy/purchase-orders/${enc(id)}/${how}`, { rev, reason }, key),
  newReceipt: (orderId: string, supplierInvoiceNo: string, key: string) => call<GoodsReceiptView>("POST", "/v1/pharmacy/goods-receipts", supplierInvoiceNo ? { orderId, supplierInvoiceNo } : { orderId }, key),
  receipt: (id: string) => call<GoodsReceiptView>("GET", `/v1/pharmacy/goods-receipts/${enc(id)}`),
  receiptLine: (id: string, body: GrnLineRequest) => call<GoodsReceiptView>("POST", `/v1/pharmacy/goods-receipts/${enc(id)}/lines`, body, k()),
  receiptRemove: (id: string, lineId: string, rev: number) => call<GoodsReceiptView>("POST", `/v1/pharmacy/goods-receipts/${enc(id)}/lines/${enc(lineId)}/remove`, { rev }, k()),
  post: (id: string, rev: number, note: string, key: string) => call<GoodsReceiptView>("POST", `/v1/pharmacy/goods-receipts/${enc(id)}/post`, note ? { rev, note } : { rev }, key),
  discard: (id: string, rev: number, key: string) => call<GoodsReceiptView>("POST", `/v1/pharmacy/goods-receipts/${enc(id)}/discard`, { rev }, key),
  counts: (status?: string) => call<CountList>("GET", "/v1/pharmacy/counts" + (status ? `?status=${status}` : "")),
  count: (id: string) => call<StockCountView>("GET", `/v1/pharmacy/counts/${enc(id)}`),
  newCount: (location: "counter" | "store" | "fridge", key: string) => call<StockCountView>("POST", "/v1/pharmacy/counts", { location }, key),
  countLine: (id: string, body: { rev: number; lineId: string; countedQty: number; reason?: string }) => call<StockCountView>("POST", `/v1/pharmacy/counts/${enc(id)}/lines`, body, k()),
  submitCount: (id: string, rev: number, key: string) => call<StockCountView>("POST", `/v1/pharmacy/counts/${enc(id)}/submit`, { rev }, key),
  decideCount: (id: string, decision: "approve" | "reject", note: string, key: string) => call<StockCountView>("POST", `/v1/pharmacy/counts/${enc(id)}/decision`, note ? { decision, note } : { decision }, key),
  approvals: (status: "requested" | "approved" | "rejected" = "requested") => call<PharmacyApprovals>("GET", `/v1/pharmacy/approvals?status=${status}`),
};

/* Admin (phase 2 slice 3, ADR 0010): owner / admin. Every write needs the server; a one-time password comes back once. */
const qs = (q: Record<string, string | undefined>) => Object.entries(q).filter(([, v]) => v).map(([k2, v]) => `${k2}=${encodeURIComponent(v!)}`).join("&");
export const adm = {
  facility: () => call<FacilityView>("GET", "/v1/admin/facility"),
  updateFacility: (body: FacilityUpdate, key: string) => call<FacilityView>("POST", "/v1/admin/facility", body, key),
  addBranch: (body: { name: string; nameBn?: string }, key: string) => call<FacilityView>("POST", "/v1/admin/branches", body, key),
  addWard: (body: { name: string; nameBn?: string; beds: number; bedClass?: string }, key: string) => call<FacilityView>("POST", "/v1/admin/wards", body, key),
  settings: (body: SettingsUpdate, key: string) => call<FacilityView>("POST", "/v1/admin/settings", body, key),
  smsTest: (phone: string, key: string) => call<FacilityView>("POST", "/v1/admin/sms-test", { phone }, key),
  smsConfirm: (key: string) => call<FacilityView>("POST", "/v1/admin/sms-test/confirm", {}, key),
  goLive: (key: string) => call<FacilityView>("POST", "/v1/admin/go-live", {}, key),
  users: () => call<UserList>("GET", "/v1/admin/users"),
  createUser: (body: UserCreate, key: string) => call<UserCredentialResponse>("POST", "/v1/admin/users", body, key),
  role: (id: string, role: string, reason: string, key: string) => call<UserView>("POST", `/v1/admin/users/${enc(id)}/role`, reason ? { role, reason } : { role }, key),
  deactivate: (id: string, reason: string, key: string) => call<UserView>("POST", `/v1/admin/users/${enc(id)}/deactivate`, { reason }, key),
  reactivate: (id: string, key: string) => call<UserView>("POST", `/v1/admin/users/${enc(id)}/reactivate`, {}, key),
  resetPassword: (id: string, key: string) => call<UserCredentialResponse>("POST", `/v1/admin/users/${enc(id)}/reset-password`, {}, key),
  verify: (id: string, regNo: string, key: string) => call<UserView>("POST", `/v1/admin/users/${enc(id)}/verify-registration`, regNo ? { regNo } : {}, key),
  prices: () => call<PriceList>("GET", "/v1/admin/prices"),
  addPrice: (body: PriceCreate, key: string) => call<PriceList>("POST", "/v1/admin/prices", body, key),
  changePrice: (id: string, body: { unitPaisa: number; vatRateBp: number; reason: string }, key: string) => call<PriceList>("POST", `/v1/admin/prices/${enc(id)}`, body, key),
  priceActive: (id: string, active: boolean, reason: string, key: string) => call<PriceList>("POST", `/v1/admin/prices/${enc(id)}/active`, { active, reason }, key),
  priceHistory: (id: string) => call<PriceHistory>("GET", `/v1/admin/prices/${enc(id)}/history`),
  audit: (q: AuditQuery) => call<AuditPage>("GET", "/v1/admin/audit?" + qs(q as Record<string, string | undefined>)),
  /** a browser URL (same origin, through the /api proxy) — the download is itself audited */
  auditCsvHref: (q: AuditQuery) => "/api/v1/admin/audit.csv?" + qs({ ...q, before: undefined } as Record<string, string | undefined>),
};
