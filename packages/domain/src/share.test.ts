/* ADR 0021 — a patient's share with a doctor (Kamrul 09/10/2026): time-limited (30 days by default, revocable), scoped
   to one visit, one report or "all", only for the chosen doctor / facility; every read decided here. */
import { describe, expect, it } from "vitest";
import { SHARE_DEFAULT_PERIOD, SHARE_PERIODS, shareCovers, shareEndsAt, shareRequestProblems, shareRevoke, shareStatusAt, type ShareFacts, type ShareItem } from "./share.js";

const now = new Date("2026-10-09T08:00:00Z");
const h = (n: number) => new Date(now.getTime() + n * 3600_000);
const linked = [{ tenantId: "t_a", patientId: "p_a" }, { tenantId: "t_b", patientId: "p_b" }];
const share = (over: Partial<ShareFacts> = {}): ShareFacts => ({
  status: "active", endsAt: h(720), granteeTenantId: "t_g", granteeUserId: "u_doc", scope: { kind: "all" }, ...over,
});
const doc: { tenantId: string; userId: string } = { tenantId: "t_g", userId: "u_doc" };
const report = (over: Partial<ShareItem> = {}): ShareItem => ({ tenantId: "t_a", patientId: "p_a", kind: "report", id: "r2", encounterId: "e1", reportChain: ["r1", "r2"], ...over });

describe("the period", () => {
  it("24 h, 7 days or 30 days — 30 days unless the patient picks another", () => {
    expect(Object.keys(SHARE_PERIODS)).toEqual(["24h", "7d", "30d"]);
    expect(SHARE_DEFAULT_PERIOD).toBe("30d");
    expect(shareEndsAt(now)).toEqual(h(720));
    expect(shareEndsAt(now, "24h")).toEqual(h(24));
    expect(shareEndsAt(now, "7d")).toEqual(h(168));
  });
});

describe("a new share", () => {
  const ok = { period: "30d", scope: { kind: "all" as const }, grantee: { tenantId: "t_g", organizationId: "o_g", userId: "u_doc" } };
  it("accepts all, a visit or a report on a linked record", () => {
    expect(shareRequestProblems(ok, linked)).toEqual([]);
    expect(shareRequestProblems({ ...ok, scope: { kind: "visit", tenantId: "t_a", patientId: "p_a", encounterId: "e1" } }, linked)).toEqual([]);
    expect(shareRequestProblems({ ...ok, scope: { kind: "report", tenantId: "t_b", patientId: "p_b", reportId: "r9" } }, linked)).toEqual([]);
  });
  it("refuses a record the person has not linked (another patient, another facility)", () => {
    expect(shareRequestProblems({ ...ok, scope: { kind: "visit", tenantId: "t_a", patientId: "p_sister", encounterId: "e1" } }, linked)).toEqual(["not_linked"]);
    expect(shareRequestProblems({ ...ok, scope: { kind: "report", tenantId: "t_x", patientId: "p_a", reportId: "r1" } }, linked)).toEqual(["not_linked"]);
  });
  it("refuses an unknown period, and \"all\" with nothing linked", () => {
    expect(shareRequestProblems({ ...ok, period: "1y" }, linked)).toEqual(["period"]);
    expect(shareRequestProblems(ok, [])).toEqual(["nothing_linked"]);
  });
  it("any directory facility may receive one, the facility the records come from included", () => {
    expect(shareRequestProblems({ ...ok, grantee: { tenantId: "t_a", organizationId: "o_a", userId: null } }, linked)).toEqual([]);
  });
});

describe("shareCovers — every read by the receiving doctor", () => {
  it("all: any record of a linked patient, for the named doctor, while it runs", () => {
    expect(shareCovers(share(), doc, report(), linked, now)).toEqual({ ok: true });
    expect(shareCovers(share(), doc, report({ tenantId: "t_b", patientId: "p_b" }), linked, now)).toEqual({ ok: true });
  });
  it("all: never a patient the person has not linked", () => {
    expect(shareCovers(share(), doc, report({ patientId: "p_sister" }), linked, now)).toEqual({ ok: false, reason: "out-of-scope" });
  });
  it("visit: only that visit's records", () => {
    const v = share({ scope: { kind: "visit", tenantId: "t_a", patientId: "p_a", encounterId: "e1" } });
    expect(shareCovers(v, doc, report(), linked, now)).toEqual({ ok: true });
    expect(shareCovers(v, doc, { tenantId: "t_a", patientId: "p_a", kind: "prescription", id: "c1", encounterId: "e1" }, linked, now)).toEqual({ ok: true });
    expect(shareCovers(v, doc, report({ encounterId: "e2" }), linked, now)).toEqual({ ok: false, reason: "out-of-scope" });
    expect(shareCovers(v, doc, report({ tenantId: "t_b", patientId: "p_b" }), linked, now)).toEqual({ ok: false, reason: "out-of-scope" });
  });
  it("report: that report, and its later corrected versions — nothing else from the visit", () => {
    const r = share({ scope: { kind: "report", tenantId: "t_a", patientId: "p_a", reportId: "r1" } });
    expect(shareCovers(r, doc, report(), linked, now)).toEqual({ ok: true });
    expect(shareCovers(r, doc, report({ id: "r7", reportChain: ["r7"] }), linked, now)).toEqual({ ok: false, reason: "out-of-scope" });
    expect(shareCovers(r, doc, { tenantId: "t_a", patientId: "p_a", kind: "prescription", id: "c1", encounterId: "e1" }, linked, now)).toEqual({ ok: false, reason: "out-of-scope" });
  });
  it("a doctor-named share is that doctor's only; a facility share is any doctor there", () => {
    expect(shareCovers(share(), { tenantId: "t_g", userId: "u_other" }, report(), linked, now)).toEqual({ ok: false, reason: "not-grantee" });
    expect(shareCovers(share(), { tenantId: "t_h", userId: "u_doc" }, report(), linked, now)).toEqual({ ok: false, reason: "not-grantee" });
    expect(shareCovers(share({ granteeUserId: null }), { tenantId: "t_g", userId: "u_other" }, report(), linked, now)).toEqual({ ok: true });
  });
  it("ADR 0023: a consent from an access request opens only the kinds approved", () => {
    const k = share({ kinds: ["report", "summary"] });
    expect(shareCovers(k, doc, report(), linked, now)).toEqual({ ok: true });
    expect(shareCovers(k, doc, { tenantId: "t_a", patientId: "p_a", kind: "prescription", id: "c1", encounterId: "e1" }, linked, now)).toEqual({ ok: false, reason: "out-of-scope" });
    expect(shareCovers(share({ kinds: [] }), doc, { tenantId: "t_a", patientId: "p_a", kind: "prescription", id: "c1", encounterId: "e1" }, linked, now)).toEqual({ ok: true });
  });
  it("ADR 0023: never a sensitive item under such a consent — answered as not shared, no hint; the patient's own share is unchanged", () => {
    expect(shareCovers(share({ hideSensitive: true }), doc, report({ sensitive: true }), linked, now)).toEqual({ ok: false, reason: "out-of-scope" });
    expect(shareCovers(share({ hideSensitive: true }), doc, report({ sensitive: false }), linked, now)).toEqual({ ok: true });
    expect(shareCovers(share(), doc, report({ sensitive: true }), linked, now)).toEqual({ ok: true });
  });
  it("ends at its end time even before the expiry job runs; a revoked share reads nothing", () => {
    expect(shareCovers(share({ endsAt: h(0) }), doc, report(), linked, now)).toEqual({ ok: false, reason: "expired" });
    expect(shareCovers(share({ status: "expired" }), doc, report(), linked, now)).toEqual({ ok: false, reason: "expired" });
    expect(shareCovers(share({ status: "revoked" }), doc, report(), linked, now)).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("status and revoke", () => {
  it("an active share past its end reads as expired", () => {
    expect(shareStatusAt({ status: "active", endsAt: h(-1) }, now)).toBe("expired");
    expect(shareStatusAt({ status: "active", endsAt: h(1) }, now)).toBe("active");
    expect(shareStatusAt({ status: "revoked", endsAt: h(1) }, now)).toBe("revoked");
  });
  it("revoke: active → revoked; again → the same (idempotent); an ended share cannot be revoked", () => {
    expect(shareRevoke({ status: "active", endsAt: h(1) }, now)).toEqual({ status: "revoked", changed: true });
    expect(shareRevoke({ status: "revoked", endsAt: h(1) }, now)).toEqual({ status: "revoked", changed: false });
    expect(shareRevoke({ status: "active", endsAt: h(-1) }, now)).toEqual({ status: "expired", changed: false, refused: "ended" });
  });
});
