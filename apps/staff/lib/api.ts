import type {
  ClassPreviewView, DeathRecordRequest, DsVerifyResponse, LamaRequest, NewPaymentRequest as IpdPaymentRequest, ReceiptView as IpdReceiptView, SaveSummaryRequest, SummaryView, DepositReceiptView, DepositRequest, DischargeList, DischargeStepDoneRequest, DischargeView, InterimPrintList, InterimPrintRequest, IpdBillList, IpdBillView, PackageList, PrintRequest as RcPrintRequest, PrintResponse as RcPrintResponse,
  WardList, WardBoard, WardPatientView, WardVitalsRequest, WardVitalsResponse, Escalation, NursingNoteView, MarView, DoseRequest, WitnessList, RoundWorklist, RoundView, SaveRoundRequest, IndentCreate, IndentView, IndentList, IndentIssueRequest, WardStock, BedMoveRequest, WristbandView, BatchLabels, IoView, IoEntryRequest, IoEntryView, CareTaskCreate, CareTaskList, WardHandover, HandoverView, HandoverPatientUpdate,
  AdmissionList, AdmissionView, AdmitRequest, BedActionRequest, BedBoard, BedView, ErArrivalRequest, ErArrivalResponse, ErAssignRequest, ErBoard, ErBoardItem, ErDispositionRequest, ErTriageRequest, ErVisitView,
  RefundableView, RefundRequest, RefundView, RefundDecisionRequest, RefundPayRequest, RefundReleaseRequest, RefundPayResponse, RefundList, RefundVoucherView, RefundVoucherPrintResponse, ReconcileRefundRequest, ResaleRequest,
  SharedList, SharedRecords, SharedReportView,
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
import { t as tr } from "@setu/i18n";
import { clearRefusedForOwner, enqueue, flush, setOutboxOwner } from "./outbox";
import { deviceId } from "./devicekeys";
export class ApiFailure extends Error { constructor(public status: number, public body: ApiError) { super(body.message_en); } }
/** ADR 0010: the server said this session has ended (switched off, role or password changed) — the sign-in page says why. */
let sessionEnded = false;
export const wasSessionEnded = () => sessionEnded;

async function call<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
  const r = await fetch("/api" + path, {
    method, credentials: "include",
    // Only a request with a body says it is JSON: an empty JSON body is refused by the API (hands-on test 02/10/2026: sign-out).
    // gap 10: the device's id goes with every request (the sign-in binds the device keys to it)
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(idemKey ? { "idempotency-key": idemKey } : {}), "x-setu-device": deviceId() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let e: ApiError = { code: "http_" + r.status, message_bn: tr("bn", "shellApp", "err_server"), message_en: r.statusText }; try { e = await r.json(); } catch {}
    // ADR 0010: switched off, the role changed or the password reset — this session has ended: back to sign-in, saying why
    if (r.status === 401 && e.code === "session_ended") sessionEnded = true;
    if (r.status === 401 && e.code === "session_ended" && typeof location !== "undefined" && location.pathname !== "/login") {
      // the refused list goes as at sign-out; drafts stay sealed and become unreadable with the key gone (gap 10, Kamrul
      // 07/10/2026: listed as a count at the next sign-in, gone at 24 h)
      clearRefusedForOwner(); setOutboxOwner(null);
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
    throw new ApiFailure(0, { code: "offline", message_bn: tr("bn", "shellApp", "err_offline_not_saved"), message_en: tr("en", "shellApp", "err_offline_not_saved") });
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
  /** all: every done / no-show token, not only the latest RECENT_DONE */
  queue: (all = false) => call<QueueResponse>("GET", "/v1/queue" + (all ? "?all=1" : "")),
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
  /** all: every visit this doctor saw today, not only the latest RECENT_DONE */
  worklist: (all = false) => call<ConsultWorklist>("GET", "/v1/consultations/worklist" + (all ? "?all=1" : "")),
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
  /** all: every settled bill of the day too, not only the latest RECENT_DONE */
  worklist: (all = false) => call<BillingWorklist>("GET", "/v1/billing/worklist" + (all ? "?all=1" : "")),
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

/* Refunds (ADR 0013). Refunds need a connection — never queued on this device (no outbox): every call goes to the server
   and the screen shows its answer. `key`: the caller's Idempotency-Key (kept after a network error, renewed after a 4xx). */
export const refunds = {
  refundable: (invoiceId: string) => call<RefundableView>("GET", `/v1/invoices/${enc(invoiceId)}/refundable`),
  request: (invoiceId: string, body: RefundRequest, key: string) => call<RefundView>("POST", `/v1/invoices/${enc(invoiceId)}/refunds`, body, key),
  list: (q: { status?: string; invoiceId?: string; days?: number } = {}) => call<RefundList>("GET", `/v1/refunds?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()}`),
  view: (id: string) => call<RefundView>("GET", `/v1/refunds/${enc(id)}`),
  decide: (id: string, body: RefundDecisionRequest, key: string) => call<RefundView>("POST", `/v1/refunds/${enc(id)}/decision`, body, key),
  pay: (id: string, body: RefundPayRequest, key: string) => call<RefundPayResponse>("POST", `/v1/refunds/${enc(id)}/pay`, body, key),
  check: (id: string) => call<RefundView>("POST", `/v1/refunds/${enc(id)}/check`, {}, crypto.randomUUID()),
  /** decision 235: the owner settles a gateway refund stuck "processing" from what the bKash portal shows */
  release: (id: string, body: RefundReleaseRequest, key: string) => call<RefundView>("POST", `/v1/refunds/${enc(id)}/release`, body, key),
  voucher: (id: string) => call<RefundVoucherView>("GET", `/v1/refunds/${enc(id)}/voucher`),
  print: (id: string, body: PrintRequest, key: string) => call<RefundVoucherPrintResponse>("POST", `/v1/refunds/${enc(id)}/voucher/print`, body, key),
  verify: (code: string) => call<VerifyResponse>("GET", `/v1/verify/rf/${enc(code)}`),
  caseRefund: (taskId: string, body: ReconcileRefundRequest, key: string) => call<RefundView>("POST", `/v1/reconciliation/${enc(taskId)}/refund`, body, key),
  resale: (body: ResaleRequest, key: string) => call<{ resaleId: string; fromBatchId: string; toBatchId: string; qty: number }>("POST", "/v1/pharmacy/resale", body, key),
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
  /** acceptDuplicate: the person accepted that the patient may get it twice (ADR 0012) */
  retry: (communicationId: string, key: string, acceptDuplicate = false) => call<LabVisitView>("POST", `/v1/lab/communications/${enc(communicationId)}/retry`, acceptDuplicate ? { acceptDuplicate } : {}, key),
  revoke: (orderId: string, reason: string, key: string) => call<RevokeResponse>("POST", `/v1/orders/${enc(orderId)}/revoke`, { reason }, key),
  /** dev and tests only: the fake SMS gateway fails the next send (the API refuses it with a real gateway or in production) */
  failNextSms: () => call<{ failing: number }>("POST", "/v1/dev/fake-messenger/fail-next", { n: 1 }),
};

/* Doctor's inbox and printed documents (slice A12–A13, ADR 0007). An acknowledgement made offline waits in the outbox
   with its Idempotency-Key and the screen says "Acknowledged — not yet synced"; nothing is sent to the patient until
   the server has stored it. Printing needs the server (the PDF is rendered and logged there). */
export type DocKindT = "rx" | "lr" | "ds";
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
  verifyDs: (code: string) => call<DsVerifyResponse>("GET", `/v1/verify/ds/${enc(code)}`),
};

/* Shift close and the owner dashboard (slice C1–C4, ADR 0008). Opening, counting and reviewing need the server (the
   drawer's expected cash is the server's figure); nothing is "handed over" or "approved" until it answers. */
export const shifts = {
  mine: () => call<MyShiftResponse>("GET", "/v1/shifts/mine"),
  open: (openingFloatPaisa: number, key: string) => call<ShiftView>("POST", "/v1/shifts", { openingFloatPaisa }, key),
  count: (id: string, body: CountShiftRequest, key: string) => call<ShiftView>("POST", `/v1/shifts/${enc(id)}/count`, body, key),
  /** external review A5: a counted shift with a variance is handed over with its reason */
  handOver: (id: string, reason: string, key: string) => call<ShiftView>("POST", `/v1/shifts/${enc(id)}/hand-over`, reason ? { reason } : {}, key),
  list: (status: "closed" | "open" | "approved" | "all" = "closed") => call<ShiftList>("GET", `/v1/shifts?status=${status}`),
  view: (id: string) => call<ShiftView>("GET", `/v1/shifts/${enc(id)}`),
  review: (id: string, decision: "approve" | "recount", note: string, key: string) => call<ShiftView>("POST", `/v1/shifts/${enc(id)}/review`, { decision, ...(note ? { note } : {}) }, key),
};
export const owner = {
  dashboard: (period: "today" | "7d" | "30d") => call<DashboardView>("GET", `/v1/owner/dashboard?period=${period}`),
  drill: (period: "today" | "7d" | "30d", what: DrillView["what"], cursor?: string | null) => call<DrillView>("GET", `/v1/owner/drill?period=${period}&what=${what}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
};

export const api = {
  health: () => call<{ ok: true; version: string; db: string }>("GET", "/health"),
  login: (identifier: string, password: string, demoPlan?: string) => call<Me>("POST", "/v1/auth/login", { identifier, password, ...(demoPlan ? { demoPlan } : {}) }),
  logout: () => call<{ ok: true }>("POST", "/v1/auth/logout"),
  me: () => call<Me>("GET", "/v1/me"),
  capabilities: () => call<Capabilities>("GET", "/v1/me/capabilities"),
  pinVerify: (pin: string) => call<{ ok: boolean; triesLeft?: number; lockedUntil?: string }>("POST", "/v1/auth/pin/verify", { pin }),
  /** ADR 0010: the first sign-in with a one-time password sets the user's own password and PIN */
  firstSignIn: (password: string, pin: string) => call<Me>("POST", "/v1/auth/first-sign-in", { password, pin }, k()),
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
  newSupplier: (body: { name: string; phone?: string; vatTreatment?: "included" | "on-top" | "exempt" }) => call<SupplierLedger>("POST", "/v1/pharmacy/suppliers", body, k()),
  supplierVat: (id: string, vatTreatment: "included" | "on-top" | "exempt") => call<SupplierLedger>("POST", `/v1/pharmacy/suppliers/${enc(id)}/vat`, { vatTreatment }, k()),
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
  post: (id: string, rev: number, note: string, key: string, tax: { supplierVatPaisa?: number; supplierAitPaisa?: number } = {}) => call<GoodsReceiptView>("POST", `/v1/pharmacy/goods-receipts/${enc(id)}/post`, { rev, ...(note ? { note } : {}), ...tax }, key),
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

/* ER and admission (ADR 0014, slice B1–B2). Every write waits for the server (the token, the bed, the signed note are
   the server's answers); `key`: one per filled-in form or per opening of the PIN sheet, so a retry is the same request. */
export const er = {
  board: () => call<ErBoard>("GET", "/v1/er/board"),
  search: (q: string) => call<PatientSearchResponse>("GET", "/v1/er/patients?q=" + encodeURIComponent(q)),
  bayReady: (id: string) => call<ErBoard["bays"][number]>("POST", `/v1/er/bays/${enc(id)}/ready`, {}, k()),
  arrive: (body: ErArrivalRequest, key: string) => call<ErArrivalResponse>("POST", "/v1/er/arrivals", body, key),
  triage: (id: string, body: ErTriageRequest) => call<ErBoardItem>("POST", `/v1/er/encounters/${enc(id)}/triage`, body, k()),
  assign: (id: string, body: ErAssignRequest) => call<ErBoardItem>("POST", `/v1/er/encounters/${enc(id)}/assign`, body, k()),
  visit: (id: string) => call<ErVisitView>("GET", `/v1/er/encounters/${enc(id)}`),
  order: (id: string, testCode: string) => call<ErVisitView>("POST", `/v1/er/encounters/${enc(id)}/orders`, { testCode }, k()),
  careOrder: (id: string, key: string, on: boolean) => call<ErVisitView>("POST", `/v1/er/encounters/${enc(id)}/care-orders`, { key, on }, k()),
  notes: (id: string, rev: number, notes: string) => call<ErVisitView>("PUT", `/v1/er/encounters/${enc(id)}/notes`, { rev, notes }, k()),
  sign: (id: string, body: ErDispositionRequest, key: string) => call<ErVisitView>("POST", `/v1/er/encounters/${enc(id)}/disposition`, body, key),
};
export const ipd = {
  beds: (cls?: string) => call<BedBoard>("GET", "/v1/ipd/beds" + (cls ? `?class=${enc(cls)}` : "")),
  bedAction: (id: string, body: BedActionRequest, key: string) => call<BedView>("POST", `/v1/ipd/beds/${enc(id)}/actions`, body, key),
  admissions: () => call<AdmissionList>("GET", "/v1/ipd/admissions"),
  admit: (body: AdmitRequest, key: string) => call<AdmissionView>("POST", "/v1/ipd/admissions", body, key),
  admission: (id: string) => call<AdmissionView>("GET", `/v1/ipd/admissions/${enc(id)}`),
  cancel: (id: string, reason: string, key: string) => call<AdmissionView>("POST", `/v1/ipd/admissions/${enc(id)}/cancel`, { reason }, key),
};

/* The IPD running bill and the discharge checklist (ADR 0017, slice B7–B9) — money and sign-offs need the server. */
export const ipdBill = {
  list: () => call<IpdBillList>("GET", "/v1/ipd/bills"),
  view: (admissionId: string) => call<IpdBillView>("GET", `/v1/ipd/bills/${enc(admissionId)}`),
  preview: (admissionId: string, to: string) => call<ClassPreviewView>("GET", `/v1/ipd/bills/${enc(admissionId)}/preview?to=${enc(to)}`),
  charge: (admissionId: string, code: string, qty: number, key: string) => call<IpdBillView>("POST", `/v1/ipd/bills/${enc(admissionId)}/charges`, { code, qty }, key),
  withdraw: (admissionId: string, lineId: string, reason: string) => call<IpdBillView>("POST", `/v1/ipd/bills/${enc(admissionId)}/lines/${enc(lineId)}/withdraw`, { reason }, k()),
  applyPackage: (admissionId: string, packageId: string, key: string) => call<IpdBillView>("POST", `/v1/ipd/bills/${enc(admissionId)}/package`, { packageId }, key),
  deposit: (admissionId: string, body: DepositRequest, key: string) => call<IpdBillView>("POST", `/v1/ipd/bills/${enc(admissionId)}/deposits`, body, key),
  receipt: (paymentId: string) => call<DepositReceiptView>("POST", `/v1/ipd/deposits/${enc(paymentId)}/receipt`, {}, k()),
  printReceipt: (receiptId: string, body: RcPrintRequest, key: string) => call<RcPrintResponse>("POST", `/v1/receipts/${enc(receiptId)}/print`, body, key),
  interimPrints: (admissionId: string) => call<InterimPrintList>("GET", `/v1/ipd/bills/${enc(admissionId)}/interim-prints`),
  printInterim: (admissionId: string, body: InterimPrintRequest, key: string) => call<InterimPrintList>("POST", `/v1/ipd/bills/${enc(admissionId)}/interim-prints`, body, key),
  packages: () => call<PackageList>("GET", "/v1/ipd/packages"),
  /* ADR 0018 (B10): the final bill */
  issue: (admissionId: string, key: string) => call<IpdBillView>("POST", `/v1/ipd/bills/${enc(admissionId)}/issue`, {}, key),
  pay: (admissionId: string, body: IpdPaymentRequest, key: string) => call<IpdBillView>("POST", `/v1/ipd/bills/${enc(admissionId)}/payments`, body, key),
  finalReceipt: (admissionId: string) => call<IpdReceiptView>("POST", `/v1/ipd/bills/${enc(admissionId)}/receipt`, {}, k()),
};
export const discharge = {
  list: () => call<DischargeList>("GET", "/v1/ipd/discharges"),
  view: (admissionId: string) => call<DischargeView>("GET", `/v1/ipd/admissions/${enc(admissionId)}/discharge`),
  order: (admissionId: string, body: { advice: string; targetAt?: string; pin: string }, key: string) => call<DischargeView>("POST", `/v1/ipd/admissions/${enc(admissionId)}/discharge`, body, key),
  cancel: (id: string, reason: string, pin: string) => call<DischargeView>("POST", `/v1/ipd/discharges/${enc(id)}/cancel`, { reason, pin }, k()),
  take: (id: string, step: string) => call<DischargeView>("POST", `/v1/ipd/discharges/${enc(id)}/steps/${enc(step)}/take`, {}, k()),
  done: (id: string, step: string, body: DischargeStepDoneRequest, key: string) => call<DischargeView>("POST", `/v1/ipd/discharges/${enc(id)}/steps/${enc(step)}/done`, body, key),
  remind: (id: string, step: string) => call<DischargeView>("POST", `/v1/ipd/discharges/${enc(id)}/steps/${enc(step)}/remind`, {}, k()),
  /* ADR 0018 (B12): LAMA and a death on the ward — the doctor's record with the PIN */
  lama: (admissionId: string, body: LamaRequest, key: string) => call<DischargeView>("POST", `/v1/ipd/admissions/${enc(admissionId)}/lama`, body, key),
  death: (admissionId: string, body: DeathRecordRequest, key: string) => call<DischargeView>("POST", `/v1/ipd/admissions/${enc(admissionId)}/death`, body, key),
};
/* ADR 0018 (B11): the discharge summary — signing needs the server */
export const summary = {
  view: (admissionId: string) => call<SummaryView>("GET", `/v1/ipd/admissions/${enc(admissionId)}/summary`),
  open: (admissionId: string) => call<SummaryView>("POST", `/v1/ipd/admissions/${enc(admissionId)}/summary/open`, {}, k()),
  save: (id: string, body: SaveSummaryRequest, key: string) => call<SummaryView>("PUT", `/v1/ipd/summaries/${enc(id)}`, body, key),
  sign: (id: string, rev: number, pin: string, key: string) => call<SummaryView>("POST", `/v1/ipd/summaries/${enc(id)}/sign`, { rev, pin }, key),
  amend: (id: string, reason: string) => call<SummaryView>("POST", `/v1/ipd/summaries/${enc(id)}/amend`, { reason }, k()),
};

/* The ward (ADR 0015, slice B3–B4). Vitals and nursing notes may wait in the outbox with their device time (`write`);
   doses, signatures, stops, issues and bed moves need the server (`call`) — a queued dose would be a dose nobody can see. */
export const ward = {
  wards: () => call<WardList>("GET", "/v1/nursing/wards"),
  board: (wardId: string) => call<WardBoard>("GET", `/v1/nursing/wards/${enc(wardId)}/board`),
  patient: (encounterId: string) => call<WardPatientView>("GET", `/v1/nursing/encounters/${enc(encounterId)}`),
  vitals: (encounterId: string, body: WardVitalsRequest, key: string) => write<WardVitalsResponse>("POST", `/v1/nursing/encounters/${enc(encounterId)}/vitals`, body, "ward-vitals", key),
  inform: (id: string, body: { spokeTo: string; instruction: string }) => call<Escalation>("POST", `/v1/nursing/escalations/${enc(id)}/inform`, body, k()),
  resolve: (id: string, note: string) => call<Escalation>("POST", `/v1/nursing/escalations/${enc(id)}/resolve`, { note }, k()),
  note: (encounterId: string, body: { text: string; effectiveAt: string }, key: string) => write<NursingNoteView>("POST", `/v1/nursing/encounters/${enc(encounterId)}/notes`, body, "nursing-note", key),
  noteError: (id: string, reason: string) => call<NursingNoteView>("POST", `/v1/nursing/notes/${enc(id)}/entered-in-error`, { reason }, k()),
  mar: (encounterId: string, day?: string) => call<MarView>("GET", `/v1/nursing/encounters/${enc(encounterId)}/mar${day ? `?day=${day}` : ""}`),
  dose: (encounterId: string, body: DoseRequest, key: string) => call<MarView>("POST", `/v1/nursing/encounters/${enc(encounterId)}/doses`, body, key),
  doseError: (id: string, reason: string, stockDrawn?: "yes" | "no" | "unsure") => call<MarView>("POST", `/v1/nursing/doses/${enc(id)}/entered-in-error`, { reason, ...(stockDrawn ? { stockDrawn } : {}) }, k()),
  vial: (encounterId: string, body: { requestId: string; openedAt: string; source: "ward-stock" | "patient-supplied" }, key: string = k()) => call<MarView>("POST", `/v1/nursing/encounters/${enc(encounterId)}/vials`, body, key),
  witnesses: () => call<WitnessList>("GET", "/v1/nursing/witnesses"),
  stock: (wardId: string) => call<WardStock>("GET", `/v1/nursing/wards/${enc(wardId)}/stock`),
  indents: (wardId: string) => call<IndentList>("GET", `/v1/nursing/wards/${enc(wardId)}/indents`),
  indent: (wardId: string, body: IndentCreate, key: string) => call<IndentView>("POST", `/v1/nursing/wards/${enc(wardId)}/indents`, body, key),
  cancelIndent: (id: string, reason: string) => call<IndentView>("POST", `/v1/indents/${enc(id)}/cancel`, { reason }, k()),
  pharmacyIndents: (status?: string) => call<IndentList>("GET", "/v1/pharmacy/indents" + (status ? `?status=${status}` : "")),
  issue: (id: string, body: IndentIssueRequest, key: string) => call<IndentView>("POST", `/v1/pharmacy/indents/${enc(id)}/issue`, body, key),
  rounds: () => call<RoundWorklist>("GET", "/v1/ipd/rounds"),
  round: (encounterId: string) => call<RoundView>("GET", `/v1/ipd/encounters/${enc(encounterId)}/round`),
  openRound: (encounterId: string) => call<RoundView>("POST", `/v1/ipd/encounters/${enc(encounterId)}/round/open`, {}, k()),
  saveRound: (id: string, body: SaveRoundRequest) => call<RoundView>("PUT", `/v1/ipd/round-notes/${enc(id)}`, body, k()),
  signRound: (id: string, body: { rev: number; pin: string }, key: string) => call<RoundView>("POST", `/v1/ipd/round-notes/${enc(id)}/sign`, body, key),
  amendRound: (id: string, reason: string) => call<RoundView>("POST", `/v1/ipd/round-notes/${enc(id)}/amend`, { reason }, k()),
  stopOrder: (id: string, body: { reason: string; pin: string }, key: string) => call<RoundView>("POST", `/v1/ipd/orders/${enc(id)}/stop`, body, key),
  medicines: (q: string) => call<{ items: MarView["orders"][number]["medicine"][] }>("GET", `/v1/ipd/medicines?q=${enc(q)}`),
  counts: (wardId: string) => call<CountList>("GET", `/v1/nursing/wards/${enc(wardId)}/counts`),
  startCount: (wardId: string, key: string) => call<StockCountView>("POST", `/v1/nursing/wards/${enc(wardId)}/counts`, {}, key),
  count: (id: string) => call<StockCountView>("GET", `/v1/nursing/counts/${enc(id)}`),
  countLine: (id: string, body: { rev: number; lineId: string; countedQty: number; reason?: string }) => call<StockCountView>("POST", `/v1/nursing/counts/${enc(id)}/lines`, body, k()),
  submitCount: (id: string, rev: number, key: string) => call<StockCountView>("POST", `/v1/nursing/counts/${enc(id)}/submit`, { rev }, key),
  // ADR 0016
  wristband: (encounterId: string, reason: string | undefined, key: string) => call<WristbandView>("POST", `/v1/nursing/encounters/${enc(encounterId)}/wristband`, reason ? { reason } : {}, key),
  labels: (batchIds: string[]) => call<BatchLabels>("POST", "/v1/nursing/labels", { batchIds }, k()),
  io: (encounterId: string, day?: string) => call<IoView>("GET", `/v1/nursing/encounters/${enc(encounterId)}/io${day ? `?day=${day}` : ""}`),
  addIo: (encounterId: string, body: IoEntryRequest, key: string) => write<IoEntryView>("POST", `/v1/nursing/encounters/${enc(encounterId)}/io`, body, "io-entry", key),
  ioError: (id: string, reason: string) => call<IoEntryView>("POST", `/v1/nursing/io/${enc(id)}/entered-in-error`, { reason }, k()),
  tasks: (encounterId: string) => call<CareTaskList>("GET", `/v1/nursing/encounters/${enc(encounterId)}/tasks`),
  addTask: (encounterId: string, body: CareTaskCreate, key: string) => call<CareTaskList>("POST", `/v1/nursing/encounters/${enc(encounterId)}/tasks`, body, key),
  completeTask: (id: string, key: string) => call<CareTaskList>("POST", `/v1/nursing/tasks/${enc(id)}/complete`, {}, key),
  cancelTask: (id: string, reason: string) => call<CareTaskList>("POST", `/v1/nursing/tasks/${enc(id)}/cancel`, { reason }, k()),
  handover: (wardId: string) => call<WardHandover>("GET", `/v1/nursing/wards/${enc(wardId)}/handover`),
  openHandover: (wardId: string, key: string) => call<HandoverView>("POST", `/v1/nursing/wards/${enc(wardId)}/handover`, {}, key),
  handoverPatient: (id: string, encounterId: string, body: HandoverPatientUpdate) => call<HandoverView>("PUT", `/v1/nursing/handovers/${enc(id)}/patients/${enc(encounterId)}`, body, k()),
  signHandover: (id: string, body: { rev: number; pin: string }, key: string) => call<HandoverView>("POST", `/v1/nursing/handovers/${enc(id)}/sign`, body, key),
  acceptHandover: (id: string, body: { rev: number; pin: string; note: string }, key: string) => call<HandoverView>("POST", `/v1/nursing/handovers/${enc(id)}/accept`, body, key),
  queryHandover: (id: string, body: { rev: number; note: string }) => call<HandoverView>("POST", `/v1/nursing/handovers/${enc(id)}/query`, body, k()),
  move: (admissionId: string, body: BedMoveRequest, key: string) => call<AdmissionView>("POST", `/v1/ipd/admissions/${enc(admissionId)}/transfer`, body, key),
  arrive: (admissionId: string) => call<AdmissionView>("POST", `/v1/ipd/admissions/${enc(admissionId)}/transfer/arrive`, {}, k()),
  cancelMove: (admissionId: string, reason: string) => call<AdmissionView>("POST", `/v1/ipd/admissions/${enc(admissionId)}/transfer/cancel`, { reason }, k()),
};

/* ADR 0021: "Shared with you" — a patient's records shared with this doctor or this facility's doctors */
export const net = {
  shared: () => call<SharedList>("GET", "/v1/shared"),
  records: (consentId: string) => call<SharedRecords>("GET", `/v1/shared/${encodeURIComponent(consentId)}`),
  report: (consentId: string, tenantId: string, reportId: string) => call<SharedReportView>("GET", `/v1/shared/${encodeURIComponent(consentId)}/reports/${encodeURIComponent(tenantId)}/${encodeURIComponent(reportId)}`),
  pdfUrl: (consentId: string, tenantId: string, kind: "lr" | "rx" | "ds", id: string, lang: "bn" | "en") => `/api/v1/shared/${encodeURIComponent(consentId)}/documents/${encodeURIComponent(tenantId)}/${kind}/${encodeURIComponent(id)}/pdf?lang=${lang}`,
};
