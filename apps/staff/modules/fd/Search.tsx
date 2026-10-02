"use client";
/* fd/search — walkthrough A1. Ported from docs/prototype/Setu Front Desk.dc.html (screen=search). */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PatientSearchResponse, PatientSummary } from "@setu/contracts";
import { Button, Callout, Card, Icon, PageState, Pill, useToast } from "@setu/ui";
import { ApiFailure, fd } from "../../lib/api";
import { useSession } from "../../lib/session";
import { PREFILL_KEY, bannerOf, flagsOf, initials, useLabels, useT } from "./common";

export function FrontDeskSearch() {
  const s = useSession(); const T = useT(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<PatientSearchResponse | null>(null);
  const [resQ, setResQ] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setRes(null); setState("idle"); return; }
    const my = ++seq.current;
    setState("loading");
    const h = setTimeout(async () => {
      try { const r = await fd.search(term); if (my === seq.current) { setRes(r); setResQ(term); setSel(0); setState("idle"); } }
      catch { if (my === seq.current) setState("error"); }
    }, 220);
    return () => clearTimeout(h);
  }, [q]);

  const items = res?.items ?? [];
  const picked: PatientSummary | undefined = items[Math.min(sel, items.length - 1)];
  useEffect(() => { s.setPatient(picked ? bannerOf(picked, L) : null); }, [picked?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* Prefill travels in sessionStorage, never the URL (names and phones stay out of history and logs). */
  const register = (prefill?: { phone?: string }) => {
    const t = q.trim();
    const p: Record<string, string> = prefill?.phone ? { phone: prefill.phone }
      : t && res?.mode === "phone" ? { phone: t } : t && res?.mode === "bn" ? { nameBn: t } : t && res?.mode === "en" ? { nameEn: t } : {};
    try { sessionStorage.setItem(PREFILL_KEY, JSON.stringify(p)); } catch {}
    router.push("/m/fd/register");
  };
  const createVisit = async (p: PatientSummary) => {
    if (busy) return; setBusy(true);
    try {
      const r = await fd.createVisit(p.id);
      if (r.queued) { toast(T("queued_offline"), "cloud-off"); return; }
      toast(T("visit_created", { token: r.data.encounter.token, name: s.lang === "bn" ? r.data.patient.nameBn : r.data.patient.nameEn ?? r.data.patient.nameBn }), "ticket");
      router.push(`/m/fd/queue?sel=${r.data.encounter.id}`);
    } catch (e) {
      if (e instanceof ApiFailure && e.body.code === "visit_exists") {
        toast(s.L(e.body.message_bn, e.body.message_en), "ticket");
        const id = (e.body.existing as { encounterId?: string } | undefined)?.encounterId;
        router.push(`/m/fd/queue${id ? `?sel=${id}` : ""}`);
      } else toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("error_generic"), "triangle-alert");
    } finally { setBusy(false); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, Math.max(0, items.length - 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
    // Never act on a list that is still loading or belongs to an earlier search (clinical review: wrong patient).
    else if (e.key === "Enter" && picked && state === "idle" && resQ === q.trim()) { e.preventDefault(); void createVisit(picked); }
    else if (e.key === "Enter") e.preventDefault();
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); register(); }
      if (e.key === "F2") { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  const modeLabel = T(res && q.trim() ? `mode_${res.mode}` : "mode_any");
  const nameOf = (p: PatientSummary) => (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn);
  const flags = useMemo(() => new Map(items.map((p) => [p.id, flagsOf(p)])), [items]);

  return (
    <div data-screen="fd/search" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div className="search" style={{ flex: "1 1 420px", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Icon name="search" size={18} />
          <input ref={input} autoFocus className="input" style={{ flex: 1, minWidth: 0, height: 44, fontSize: 16 }} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            role="combobox" aria-expanded={items.length > 0} aria-controls="fd-results" aria-label={T("search_label")} placeholder={T("search_placeholder")} />
          <Pill tone="neu">{modeLabel}</Pill>
        </div>
        <Button icon="user-plus" kbd="Alt N" onClick={() => register()}>{T("new_patient")}</Button>
      </div>
      <span className="t-small t-muted">{T("hint_keys")}</span>

      {!q.trim() && <PageState icon="search" title={T("type_to_search_title")} body={T("type_to_search_body")} />}
      {state === "error" && <Callout tone="warn" icon="triangle-alert">{T("search_failed")}</Callout>}

      {q.trim() && res && state !== "error" && (
        <>
          {res.sharedPhone && (
            <Callout tone="warn" icon="users">
              <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <b data-testid="shared-phone">{T("shared_phone_title", { n: res.sharedPhone.count, phone: L.phone(res.sharedPhone.phone) })}</b>
                <span>{T("shared_phone_body")}</span>
              </span>
            </Callout>
          )}
          {items.length === 0 ? (
            <PageState icon="user-search" title={T("no_match_title", { q: q.trim() })} body={T("no_match_body")}
              actions={<Button variant="primary" icon="user-plus" kbd="Alt N" onClick={() => register()}>{T("register_with_q", { q: q.trim() })}</Button>} />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 340px)", gap: 16, alignItems: "start" }} className="fd-split">
              <Card style={{ padding: 0, overflowX: "auto" }}>
                <div id="fd-results" role="listbox" aria-label={T("search_label")}>
                  <div className="t-label t-muted" style={{ display: "grid", gridTemplateColumns: GRID, gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)", minWidth: 720 }}>
                    <span>{T("col_name")}</span><span>{T("col_age")}</span><span>{T("col_guardian")}</span><span>{T("col_phone")}</span><span>{T("col_last")}</span><span>{T("col_flags")}</span>
                  </div>
                  {items.map((p, i) => (
                    <div key={p.id} role="option" aria-selected={i === sel} data-patient={p.facilityNo} onClick={() => setSel(i)} onDoubleClick={() => void createVisit(p)}
                      style={{ display: "grid", gridTemplateColumns: GRID, gap: 8, padding: "10px 12px", alignItems: "center", cursor: "pointer", minWidth: 720, borderBottom: "1px solid var(--border-subtle)", background: i === sel ? "var(--brand-primary-subtle)" : undefined }}>
                      <span style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                        <span className="avatar" style={{ width: 28, height: 28, flex: "none" }}>{initials(p.nameEn, p.nameBn)}</span>
                        <span style={{ minWidth: 0 }}><b>{nameOf(p)}</b><span className="t-small t-muted" style={{ display: "block" }}>{s.lang === "bn" ? p.nameEn : p.nameBn} · <span className="num">{p.facilityNo}</span></span></span>
                      </span>
                      <span className="num">{L.age(p)} {L.sex(p.sex)}</span>
                      <span>{p.guardian ? <>{p.guardian.name}<span className="t-small t-muted" style={{ display: "block" }}>{L.rel(p.guardian.relationship)}</span></> : p.phoneOwner === "self" ? <span className="t-muted">{L.rel("self")}</span> : "—"}</span>
                      <span className="num" style={{ whiteSpace: "nowrap" }}>{s.n(L.phone(p.phone))}</span>
                      <span className="num">{p.lastVisitAt ? s.n(new Date(p.lastVisitAt).toLocaleDateString("en-GB")) : T("never")}</span>
                      <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{(flags.get(p.id) ?? []).slice(0, 2).map((f) => <Pill key={f.key} tone={f.tone} icon={f.icon}>{T(f.key)}</Pill>)}</span>
                    </div>
                  ))}
                </div>
                <div className="t-small t-muted" style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", gap: 8, flexWrap: "wrap" }}>
                  <span>{T("n_found", { n: items.length })}</span><span>{T("never_merge")}</span>
                </div>
              </Card>
              {picked && (
                <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }} aria-label="selected-patient">
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span className="avatar" style={{ width: 40, height: 40 }}>{initials(picked.nameEn, picked.nameBn)}</span>
                    <span><b>{picked.nameBn}</b><span className="t-small t-muted" style={{ display: "block" }}>{picked.nameEn} · {L.age(picked)} {L.sex(picked.sex)}</span></span>
                  </div>
                  <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", margin: 0 }} className="t-small">
                    <dt className="t-muted">{T("patient_no")}</dt><dd className="num" style={{ margin: 0 }}>{picked.facilityNo}</dd>
                    <dt className="t-muted">{T("col_guardian")}</dt><dd style={{ margin: 0 }}>{picked.guardian ? `${picked.guardian.name} · ${L.rel(picked.guardian.relationship)}` : "—"}</dd>
                    <dt className="t-muted">{T("col_last")}</dt><dd className="num" style={{ margin: 0 }}>{picked.lastVisitAt ? s.n(new Date(picked.lastVisitAt).toLocaleDateString("en-GB")) : T("never")}</dd>
                    <dt className="t-muted">{T("address")}</dt><dd style={{ margin: 0 }}>{[picked.address.upazila, picked.address.district].filter(Boolean).join(", ") || "—"}</dd>
                  </dl>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{(flags.get(picked.id) ?? []).map((f) => <Pill key={f.key} tone={f.tone} icon={f.icon}>{T(f.key)}</Pill>)}</div>
                  {picked.identityConfidence === "possible-duplicate" && (
                    <Callout tone="warn" icon="users">
                      <span style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                        <span>{T("dup_note")}</span>
                        <Button size="sm" icon="git-compare" onClick={() => router.push(`/m/fd/match?id=${picked.id}`)}>{T("compare")}</Button>
                      </span>
                    </Callout>
                  )}
                  <Button variant="primary" icon="ticket" kbd="Enter" disabled={busy} onClick={() => void createVisit(picked)}>{T("create_visit")}</Button>
                  {picked.phone && <Button icon="user-plus" onClick={() => register({ phone: "0" + picked.phone })}>{T("new_family_member")}</Button>}
                </Card>
              )}
            </div>
          )}
        </>
      )}
      {q.trim() && !res && state === "loading" && <div aria-busy="true" className="t-muted">{T("searching")}</div>}
    </div>
  );
}
const GRID = "minmax(200px, 2.2fr) 80px minmax(120px, 1.4fr) 130px 100px minmax(150px, 1.4fr)";
