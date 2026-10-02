"use client";
/* fd/queue — walkthrough A3 (lands on the token just created). Ported from docs/prototype/Setu Front Desk.dc.html
   (screen=queue). The board is a view of ENCOUNTER states; call / next / no-show go to the API, which applies them
   through the machine. Reorder with reason comes in a later slice. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { QueueItem, QueueResponse } from "@setu/contracts";
import { Button, Callout, Card, Dialog, PageState, Pill, useToast } from "@setu/ui";
import { ApiFailure, fd } from "../../lib/api";
import { useSession } from "../../lib/session";
import { bannerOf, useLabels, useT } from "./common";

const NEXT_LABEL: Record<string, string> = { arrived: "next_vitals", triaged: "next_doctor", "in-progress": "next_complete" };
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "");

export function FrontDeskQueue() {
  const s = useSession(); const T = useT(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const params = useSearchParams();
  const justRegistered = params.get("new") === "1" ? params.get("sel") : null;
  const [q, setQ] = useState<QueueResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [sel, setSel] = useState<string | null>(params.get("sel"));
  const [busy, setBusy] = useState(false);
  const [confirmNoShow, setConfirmNoShow] = useState(false);

  const load = useCallback(async () => {
    try { setQ(await fd.queue()); setState("ready"); } catch { setState((x) => (x === "ready" ? x : "error")); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t); }, [load]);

  const all = q?.columns.flatMap((c) => c.items) ?? [];
  const picked: QueueItem | undefined = all.find((i) => i.id === sel);
  useEffect(() => { s.setPatient(picked ? bannerOf(picked.patient, L) : null); }, [picked?.id, picked?.status, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Bring the token we landed on into view once (not on every refresh or click, which would yank the page).
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !q || !sel) return;
    const el = document.querySelector<HTMLElement>(`[data-token-id="${sel}"]`);
    if (el) { landed.current = true; el.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  }, [q, sel]);

  const act = async (action: "call" | "next" | "noShow") => {
    if (!picked || busy || !picked.actions.includes(action)) return;
    setBusy(true);
    try { await fd.act(picked.id, action); await load(); }
    catch (e) {
      if (e instanceof ApiFailure && (e.body.code === "stale" || e.body.code === "invalid_transition")) { toast(T("stale_refresh"), "refresh-cw"); await load(); }
      else toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("error_generic"), "triangle-alert");
    } finally { setBusy(false); }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.ctrlKey || e.metaKey) return;
      if (e.altKey && e.key.toLowerCase() === "t") { e.preventDefault(); router.push("/m/fd/search"); return; }
      if (e.altKey) return;
      if (e.key.toLowerCase() === "c") void act("call");
      else if (e.key.toLowerCase() === "n" && picked?.actions.includes("noShow")) setConfirmNoShow(true); // final: always confirm
      else if (e.key === "Enter" && (e.target as HTMLElement | null)?.tagName !== "BUTTON") void act("next");
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  const name = (i: QueueItem) => (s.lang === "bn" ? i.patient.nameBn : i.patient.nameEn ?? i.patient.nameBn);
  const waiting = q?.columns.find((c) => c.key === "waiting")?.items ?? [];

  return (
    <div data-screen="fd/queue" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{T("queue_title")}</h1>
        {q && <span className="t-small t-muted">{s.lang === "bn" ? q.branch.nameBn ?? q.branch.name : q.branch.name} · <span className="num">{s.n(q.day.split("-").reverse().join("/"))}</span></span>}
        <span style={{ marginLeft: "auto" }} />
        <Button icon="plus" kbd="Alt T" onClick={() => router.push("/m/fd/search")}>{T("new_token")}</Button>
      </div>

      {state === "loading" && !q && <div aria-busy="true" className="t-muted">{T("queue_loading")}</div>}
      {state === "error" && !q && <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>}
      {q && all.length === 0 && <PageState icon="ticket" title={T("queue_empty_title")} body={T("queue_empty_body")} actions={<Button variant="primary" icon="plus" onClick={() => router.push("/m/fd/search")}>{T("new_token")}</Button>} />}

      {q && all.length > 0 && (
        <>
          <Card style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 14px" }} data-testid="queue-selected">
            <span className="t-small t-muted">{T("selected")}:</span>
            {picked ? (
              <>
                <b className="num" style={{ whiteSpace: "nowrap", fontSize: 18 }} data-testid="selected-token">{picked.token}</b>
                <b>{name(picked)}</b>
                <span className="t-small t-muted num">{picked.patient.facilityNo} · {L.age(picked.patient)} {L.sex(picked.patient.sex)}</span>
                {picked.calledAt && <Pill tone="info" icon="megaphone">{T("called_at", { t: s.n(hhmm(picked.calledAt)) })}</Pill>}
                <span style={{ marginLeft: "auto" }} />
                <Button icon="megaphone" kbd="C" disabled={busy || !picked.actions.includes("call")} onClick={() => void act("call")}>{T("call")}</Button>
                {picked.actions.includes("next") && <Button variant="primary" icon="arrow-right" kbd="Enter" disabled={busy} onClick={() => void act("next")}>{T(NEXT_LABEL[picked.status] ?? "next_complete")}</Button>}
                <Button icon="user-x" kbd="N" disabled={busy || !picked.actions.includes("noShow")} onClick={() => setConfirmNoShow(true)}>{T("no_show")}</Button>
              </>
            ) : <span className="t-muted">{T("select_a_token")}</span>}
          </Card>

          {/* The board fits the screen and each column scrolls on its own, so the action bar above never leaves view. */}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${q.columns.length}, minmax(190px, 1fr))`, gap: 12, overflowX: "auto", paddingBottom: 4, height: "max(360px, calc(100vh - 300px))" }} aria-label={T("queue_title")}>
            {q.columns.map((col) => (
              <section key={col.key} data-column={col.key} aria-label={T(`col_${col.key}`)} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, minHeight: 0, overflowY: "auto", background: "var(--surface-sunken)", borderRadius: 10, padding: 8 }}>
                <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 4px", position: "sticky", top: -8, background: "var(--surface-sunken)", zIndex: 1 }}>
                  <b className="t-small">{T(`col_${col.key}`)}</b><span className="badge-count num">{s.n(col.items.length)}</span>
                </header>
                {col.items.map((i) => {
                  const on = i.id === sel;
                  const pos = col.key === "waiting" ? waiting.findIndex((w) => w.id === i.id) + 1 : 0;
                  return (
                    <button key={i.id} type="button" data-token-id={i.id} data-token={i.token} aria-pressed={on} onClick={() => setSel(i.id)} className="card"
                      style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 4, padding: 10, cursor: "pointer", outline: on ? "2px solid var(--brand-primary)" : undefined, background: on ? "var(--brand-primary-subtle)" : undefined }}>
                      <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <b className="num" style={{ whiteSpace: "nowrap" }}>{i.token}</b>
                        {justRegistered === i.id && <Pill tone="info" icon="sparkles">{T("just_registered")}</Pill>}
                      </span>
                      <span style={{ fontWeight: 600 }}>{name(i)}</span>
                      <span className="t-small t-muted">{L.age(i.patient)} {L.sex(i.patient.sex)} · {T(`visit_${i.visitType}`)}</span>
                      <span className="t-small t-muted num">{col.key === "waiting" ? T("position", { n: pos }) : col.key === "done" || col.key === "noShow" ? s.n(hhmm(i.statusAt)) : T("since", { t: s.n(hhmm(i.statusAt)) })}</span>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
          <span className="t-small t-muted">{T("lab_billing_later")}</span>
          <Dialog open={confirmNoShow && Boolean(picked)} onClose={() => setConfirmNoShow(false)} label={picked ? T("no_show_confirm_title", { token: picked.token }) : ""} width={440}>
            {picked && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
                <h2 className="t-h3" style={{ margin: 0 }}>{T("no_show_confirm_title", { token: picked.token })}</h2>
                <span>{name(picked)} · <span className="num">{picked.patient.facilityNo}</span></span>
                <span className="t-small t-muted">{T("no_show_confirm_body")}</span>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button onClick={() => setConfirmNoShow(false)}>{T("cancel")}</Button>
                  <Button variant="danger" icon="user-x" disabled={busy} onClick={() => { setConfirmNoShow(false); void act("noShow"); }}>{T("confirm")}</Button>
                </div>
              </div>
            )}
          </Dialog>
        </>
      )}
    </div>
  );
}
