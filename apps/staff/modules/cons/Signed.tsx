"use client";
import { PrintPanel } from "../../components/PrintPanel";
/* cons/signed and cons/amended — walkthrough A5 (ADR 0003). Both read the note from the server: "Signed" appears only
   for a version the server holds as final/amended, with the server's time. Amend opens v+1 as a draft (reason ≥ 5);
   the signed version is never edited, and signing the amendment marks it superseded. The history lists every version.
   Slice A8–A11 (decision D5): the ordering doctor can cancel a test that has no sample collected yet ("Cancel test",
   reason ≥10, ORDER revoke); the visit's draft bill drops the line at once (decision 99). */
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CompositionView, ConsultationView } from "@setu/contracts";
import { rxQuantity } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, type Tone } from "@setu/ui";
import { ApiFailure, cons, lab } from "../../lib/api";
import { ReasonDialog } from "../lab/common";
import { useSession } from "../../lib/session";
import { AllergyStrip } from "./Allergies";
import { consUrl, useBanner, useC, useFmt } from "./common";

const STATUS_TONE: Record<string, Tone> = { final: "final", amended: "final", superseded: "off", "entered-in-error": "bad", draft: "draft", queued: "pend" };

function useConsultation(encounterId: string | null) {
  const s = useSession(); const banner = useBanner();
  const [view, setView] = useState<ConsultationView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!encounterId) return;
    try { setView(await cons.view(encounterId)); }
    catch (e) { setFailure(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : s.t("consultApp", "error_generic")); }
  }, [encounterId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (view) s.setPatient(banner(view)); }, [view, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  return { view, failure, load };
}

function NoPatient() {
  const C = useC(); const router = useRouter();
  return <PageState icon="stethoscope" title={C("pick_patient")} actions={<Button onClick={() => router.push(consUrl("draft"))}>{C("title_worklist")}</Button>} />;
}

export function ConsultSigned() {
  const enc = useSearchParams().get("enc");
  const s = useSession(); const C = useC(); const F = useFmt(); const router = useRouter();
  const { view, failure, load } = useConsultation(enc);
  const [amending, setAmending] = useState(false);
  const [orderNotice, setOrderNotice] = useState<string | null>(null);
  if (!enc) return <NoPatient />;
  if (failure) return <Callout tone="warn" icon="triangle-alert">{failure}</Callout>;
  if (!view) return <div aria-busy="true" className="t-muted">{C("loading")}</div>;
  const c = view.current;
  const draftOpen = view.draft;
  return (
    <div data-screen="cons/signed" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{C("title_signed")}</h1>
        <Pill tone="neu" icon="ticket">{C("token", { t: view.encounter.token })}</Pill>
        {c && <Pill tone={STATUS_TONE[c.status] ?? "neu"} icon="shield-check">{C("v_title", { v: c.version })} · {C(`status_${c.status}`)}</Pill>}
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="history" onClick={() => router.push(consUrl("amended", enc))}>{C("show_history")}</Button>
        <Button size="sm" icon="arrow-left" onClick={() => router.push(consUrl("draft"))}>{C("back_to_list")}</Button>
      </div>
      <AllergyStrip view={view} editable={!view.readOnly} onChanged={load} />
      {!c ? (
        <PageState icon="file-question" title={C("no_note")} actions={draftOpen ? <Button onClick={() => router.push(consUrl("draft", enc))}>{C("open_draft")}</Button> : undefined} />
      ) : (
        <>
          <Callout icon="shield-check" data-testid="signed-stamp">
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <b>{C("signed_at", { at: F.dateTime(c.signedAt) })}</b>
              <span>{C("signed_by", { name: F.name(c.signedBy) })}{c.signedBy?.regNo ? ` · ${C(c.signedBy.regVerified ? "reg_verified" : "reg_unverified", { body: c.signedBy.regBody ?? "", no: c.signedBy.regNo })}` : ""}</span>
              {c.amendReason && <span>{C("v_reason", { r: c.amendReason })}</span>}
            </span>
          </Callout>
          <>
            {orderNotice && <Callout tone="info" icon="ban" data-testid="order-notice">{orderNotice}</Callout>}
            <NoteView c={c} onChanged={(msg) => { setOrderNotice(msg); void load(); }} canCancel={!view.readOnly && s.me?.role === "doctor"} />
          </>
          {/* A13: the prescription of this signed version (a superseded version shows why it cannot print) */}
          <PrintPanel kind="rx" id={c.id} />
          {!view.readOnly && (
            <span style={{ display: "flex", gap: 8 }}>
              {draftOpen
                ? <Button variant="primary" icon="pen-line" onClick={() => router.push(consUrl("draft", enc))}>{C("amend_continue")}</Button>
                : <Button icon="file-pen-line" onClick={() => setAmending(true)} disabled={!s.online} title={s.online ? undefined : C("needs_connection")}>{C("amend")}</Button>}
            </span>
          )}
        </>
      )}
      {amending && c && <AmendDialog c={c} onClose={() => setAmending(false)} onDone={() => router.push(consUrl("draft", enc))} />}
    </div>
  );
}

function AmendDialog({ c, onClose, onDone }: { c: CompositionView; onClose: () => void; onDone: () => void }) {
  const s = useSession(); const C = useC();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const ok = reason.trim().length >= 5;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true); setError(null);
    try { await cons.amend(c.id, reason.trim()); onDone(); }
    catch (e) { setError(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : C("error_generic")); setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} label={C("amend_title")} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="amend-dialog">
        <b className="t-h3">{C("amend_title")}</b>
        <span className="t-small">{C("amend_body", { v: c.version })}</span>
        <label className="field">
          <span>{C("amend_reason")}</span>
          <textarea className="input" name="amend-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
        {error && <span className="field-error" role="alert">{error}</span>}
        <span role="status" className="t-small t-muted">{busy ? C("sync_saving") : ""}</span>
        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{C("cancel")}</Button>
          <Button variant="primary" disabled={!ok || busy || !s.online} onClick={() => void submit()}>{C("amend_start")}</Button>
        </span>
      </div>
    </Dialog>
  );
}

/** A signed version, read-only. */
function OrderLine({ o, canCancel, onChanged }: { o: CompositionView["orders"][number]; canCancel: boolean; onChanged: (notice: string) => void }) {
  const s = useSession(); const C = useC();
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const cancellable = canCancel && ["active", "accepted", "partially-accepted"].includes(o.status);
  return (
    <div data-order={o.testCode} data-order-status={o.status} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span>{s.L(o.nameBn, o.nameEn)} · {C(`pr_${o.priority}`)}</span>
      {o.status === "revoked" && <Pill tone="off" icon="ban">{C("order_cancelled")}</Pill>}
      {["in-progress", "partially-complete", "complete"].includes(o.status) && <Pill tone="info" icon="test-tube">{C(`order_${o.status}`)}</Pill>}
      {cancellable && <Button size="sm" variant="ghost" icon="ban" data-testid={`cancel-order-${o.testCode}`} disabled={!s.online} onClick={() => { setError(null); setOpen(true); }}>{C("order_cancel")}</Button>}
      <ReasonDialog open={open} title={C("order_cancel_title", { test: s.L(o.nameBn, o.nameEn) })} body={C("order_cancel_body")} label={C("order_cancel_reason")} confirm={C("order_cancel_confirm")} busy={busy} error={error}
        onClose={() => setOpen(false)}
        onConfirm={async (reason) => {
          setBusy(true); setError(null);
          try {
            const r = await lab.revoke(o.id, reason, key);
            setOpen(false);
            const name = s.L(o.nameBn, o.nameEn);
            onChanged(`${name}: ${r.bill && r.bill.removed.length ? C("order_cancel_bill", { lines: r.bill.removed.join(", ") }) : r.bill?.waits ? C("order_cancel_bill_waits") : C("order_cancel_done")}`);
          } catch (e) { setError(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : C("error_generic")); } finally { setBusy(false); }
        }} />
    </div>
  );
}

function NoteView({ c, onChanged, canCancel = false }: { c: CompositionView; onChanged?: (notice: string) => void; canCancel?: boolean }) {
  const s = useSession(); const C = useC();
  const x = c.sections;
  const exam = (["general", "cvs", "chest", "abdomen"] as const).filter((k) => x.exam[k].trim());
  const Row = ({ t, children }: { t: string; children: React.ReactNode }) => (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(110px, 160px) 1fr", gap: 12 }}><b className="t-small t-secondary">{t}</b><div style={{ minWidth: 0 }}>{children}</div></div>
  );
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }} data-testid="note-view" data-version={c.version} data-status={c.status}>
      <Row t={C("sec_complaints")}>{x.complaints.map((k, i) => <div key={i}>{k.text}{k.duration ? ` · ${C(`dur_${k.duration.unit}`, { n: k.duration.n })}` : ""}</div>)}</Row>
      {x.history.trim() && <Row t={C("sec_history")}><span style={{ whiteSpace: "pre-wrap" }}>{x.history}</span></Row>}
      {exam.length > 0 && <Row t={C("sec_exam")}>{exam.map((k) => <div key={k}><span className="t-muted">{C(`exam_${k}`)}:</span> <span style={{ whiteSpace: "pre-wrap" }}>{x.exam[k]}</span></div>)}</Row>}
      <Row t={C("sec_dx")}>{c.diagnoses.map((d) => (
        <div key={d.code} data-dx={d.code}><b className="num">{d.code}</b> {s.L(d.labelBn, d.labelEn)} {d.verificationStatus === "provisional" && <Pill tone="warn">{C("dx_provisional")}</Pill>}</div>
      ))}</Row>
      <Row t={C("sec_rx")}>{c.medications.length === 0 ? "—" : c.medications.map((m, i) => (
        <div key={m.id} data-rx-line={m.medicineKey}>
          <b>{s.n(i + 1)}. {m.form} {m.brand} {m.strength}</b> <span className="t-muted">({m.generic})</span> · <span className="num">{s.n(m.dose)}</span> · {C(`meal_${m.meal}`)} · {C("rx_days")} {s.n(m.days)} · {C("rx_qty")} {s.n(m.quantity || rxQuantity(m.dose, m.days))}
          {m.note && <div className="t-small t-muted">{m.note}</div>}
        </div>
      ))}</Row>
      <Row t={C("sec_orders")}>{c.orders.length === 0 ? "—" : c.orders.map((o) => <OrderLine key={o.id} o={o} canCancel={canCancel} onChanged={onChanged ?? (() => {})} />)}</Row>
      {x.advice.trim() && <Row t={C("sec_advice")}><span style={{ whiteSpace: "pre-wrap" }}>{x.advice}</span></Row>}
      {x.followUp.trim() && <Row t={C("sec_followup")}>{x.followUp}</Row>}
    </Card>
  );
}

export function ConsultAmended() {
  const enc = useSearchParams().get("enc");
  const C = useC(); const F = useFmt(); const router = useRouter();
  const { view, failure } = useConsultation(enc);
  if (!enc) return <NoPatient />;
  if (failure) return <Callout tone="warn" icon="triangle-alert">{failure}</Callout>;
  if (!view) return <div aria-busy="true" className="t-muted">{C("loading")}</div>;
  const versionOf = (id: string | null) => view.history.find((h) => h.id === id)?.version ?? (view.draft?.id === id ? view.draft?.version : undefined);
  const rows = [...view.history, ...(view.draft ? [{ id: view.draft.id, version: view.draft.version, status: view.draft.status, signedAt: null, amendReason: view.draft.amendReason, supersededById: null }] : [])]
    .sort((a, b) => b.version - a.version);
  return (
    <div data-screen="cons/amended" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{C("title_history")}</h1>
        <Pill tone="neu" icon="ticket">{C("token", { t: view.encounter.token })}</Pill>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="file-text" onClick={() => router.push(consUrl("signed", enc))}>{C("show_note")}</Button>
      </div>
      {rows.length === 0 ? <PageState icon="history" title={C("no_note")} /> : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((h) => (
            <li key={h.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12 }} data-version={h.version} data-status={h.status}>
              <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <b>{C("v_title", { v: h.version })}</b>
                <Pill tone={STATUS_TONE[h.status] ?? "neu"}>{C(`status_${h.status}`)}</Pill>
                {h.supersededById && <span className="t-small t-muted">{C("v_superseded_by", { v: versionOf(h.supersededById) ?? "?" })}</span>}
              </span>
              <span className="t-small">{h.signedAt ? C("v_signed", { at: F.dateTime(h.signedAt) }) : C("v_not_signed")}</span>
              {h.amendReason && <span className="t-small">{C("v_reason", { r: h.amendReason })}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
