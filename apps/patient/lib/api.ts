/* ADR 0020 — the patient app's calls. Every route is /v1/patient/* with the patient cookie (never the staff one). */
import type { AccessLog, CentreOffers, ChooseCentreRequest, PortableList, PortableOrderView, ApiError, ClaimItem, ClaimList, ClaimProofRequest, ClaimProofResponse, DirectoryView, OtpResponse, PatientMe, PatientReportView, ShareCreate, ShareList, ShareView, Timeline } from "@setu/contracts";
import { t } from "@setu/i18n";

/** staging serves the app under /patient (ADR 0021); locally and in CI it is the root */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export class ApiFailure extends Error { constructor(public status: number, public body: ApiError) { super(body.message_en); } }

async function call<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch("/api" + path, {
      method, credentials: "include",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(idemKey ? { "idempotency-key": idemKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ApiFailure(0, { code: "offline", message_bn: t("bn", "patientApp", "offline_need_net"), message_en: t("en", "patientApp", "offline_need_net") }); }
  if (!r.ok) {
    let e: ApiError = { code: "http_" + r.status, message_bn: t("bn", "patientApp", "err_server"), message_en: t("en", "patientApp", "err_server") };
    try { e = await r.json(); } catch {}
    // the session has ended (signed out elsewhere, or the cookie expired): back to the welcome screens
    if (r.status === 401 && typeof location !== "undefined" && !location.pathname.endsWith("/welcome")) location.href = BASE + "/welcome";
    throw new ApiFailure(r.status, e);
  }
  return r.json() as Promise<T>;
}

export const patient = {
  otp: (phone: string, lang: "bn" | "en") => call<OtpResponse>("POST", "/v1/patient/otp", { phone, lang }),
  signIn: (phone: string, code: string) => call<PatientMe>("POST", "/v1/patient/sign-in", { phone, code }),
  signOut: () => call<{ ok: true }>("POST", "/v1/patient/sign-out"),
  me: () => call<PatientMe>("GET", "/v1/patient/me"),
  claims: () => call<ClaimList>("GET", "/v1/patient/claims"),
  /** `key`: one per attempt, so a retried request after a dropped network never counts as a second wrong code */
  prove: (id: string, body: ClaimProofRequest, key: string) => call<ClaimProofResponse>("POST", `/v1/patient/claims/${encodeURIComponent(id)}/proof`, body, key),
  notMine: (id: string, key: string) => call<ClaimItem>("POST", `/v1/patient/claims/${encodeURIComponent(id)}/not-mine`, {}, key),
  timeline: (filter: string) => call<Timeline>("GET", "/v1/patient/timeline?filter=" + encodeURIComponent(filter)),
  /* D4–D6 (ADR 0021) */
  report: (claimId: string, reportId: string) => call<PatientReportView>("GET", `/v1/patient/reports/${encodeURIComponent(claimId)}/${encodeURIComponent(reportId)}`),
  /** the patient's copy of a document (opened in the browser's PDF viewer) */
  pdfUrl: (claimId: string, kind: "lr" | "rx" | "ds", id: string, lang: "bn" | "en") => `/api/v1/patient/documents/${encodeURIComponent(claimId)}/${kind}/${encodeURIComponent(id)}/pdf?lang=${lang}`,
  directory: () => call<DirectoryView>("GET", "/v1/patient/directory"),
  shares: () => call<ShareList>("GET", "/v1/patient/shares"),
  share: (body: ShareCreate, key: string) => call<ShareView>("POST", "/v1/patient/shares", body, key),
  revoke: (id: string, key: string) => call<ShareView>("POST", `/v1/patient/shares/${encodeURIComponent(id)}/revoke`, {}, key),
  /* E1 (ADR 0022): the portable lab orders, the centres, the choice */
  portableOrders: () => call<PortableList>("GET", "/v1/patient/portable-orders"),
  centres: (id: string, sort: "price" | "turnaround", collection: "centre" | "home") => call<CentreOffers>("GET", `/v1/patient/portable-orders/${encodeURIComponent(id)}/centres?sort=${sort}&collection=${collection}`),
  choose: (id: string, body: ChooseCentreRequest, key: string) => call<PortableOrderView>("POST", `/v1/patient/portable-orders/${encodeURIComponent(id)}/choose`, body, key),
  accessLog: (before: string | null) => call<AccessLog>("GET", "/v1/patient/access-log" + (before ? "?before=" + encodeURIComponent(before) : "")),
};
