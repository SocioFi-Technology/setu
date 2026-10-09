/* ADR 0020 — the patient app's calls. Every route is /v1/patient/* with the patient cookie (never the staff one). */
import type { ApiError, ClaimItem, ClaimList, ClaimProofRequest, ClaimProofResponse, OtpResponse, PatientMe, Timeline } from "@setu/contracts";
import { t } from "@setu/i18n";

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
    if (r.status === 401 && typeof location !== "undefined" && location.pathname !== "/welcome") location.href = "/welcome";
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
};
