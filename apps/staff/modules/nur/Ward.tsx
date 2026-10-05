"use client";
/* nur/ward — walkthrough B4. Ported from docs/prototype/Setu Nursing.dc.html (screen "ward"): the ward picked once and
   remembered on this device; the escalation banner (open escalations on this ward — log the doctor's contact); one card
   per bed (patient, day, doctor, allergies, NEWS2, next obs, doses due / overdue, arriving moves) with links to vitals,
   MAR, notes and the bed move; on the right, ward stock and indents (request, follow, cancel the balance). Refreshes
   every minute. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Escalation, IndentList, WardBoard, WardBoardBed, WardList, WardStock } from "@setu/contracts";
import { informBlockers } from "@setu/domain";
import { Button, Callout, Card, Dialog, Pill, SelectField, TextArea, TextField, useToast } from "@setu/ui";
import { ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { News2Pill, hhmm, rememberWard, rememberedWard, useErr, useLabels, useN } from "./common";

const name = (p: { nameBn: string; nameEn: string | null }, bn: boolean) => (bn ? p.nameBn : p.nameEn || p.nameBn);

export function NurWard() {
  const s = useSession(); const N = useN(); const err = useErr(); const router = useRouter(); const toast = useToast();
  const [wards, setWards] = useState<WardList | null>(null); const [wardId, setWardId] = useState<string | null>(null);
  const [board, setBoard] = useState<WardBoard | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const [inform, setInform] = useState<Escalation | null>(null);
  useEffect(() => {
    ward.wards().then((w) => {
      setWards(w);
      const saved = rememberedWard();
      setWardId(w.wards.find((x) => x.id === saved)?.id ?? w.wards.find((x) => x.occupied > 0)?.id ?? w.wards[0]?.id ?? null);
    }).catch((e) => setFailed(err(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async () => { if (!wardId) return; try { setBoard(await ward.board(wardId)); setFailed(null); } catch (e) { setFailed(err(e)); } }, [wardId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);
  if (failed && !board) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!wards) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bn = s.lang === "bn";
  const pick = (id: string) => { setWardId(id); rememberWard(id); setBoard(null); };
  const go = (screen: string, encounterId: string) => router.push(`/m/${screen}?enc=${encodeURIComponent(encounterId)}`);
  const occupied = board?.beds.filter((b) => b.patient).length ?? 0;
  const arrive = async (admissionId: string) => { try { await ward.arrive(admissionId); toast(N("arrived"), "badge-check"); await load(); } catch (e) { toast(err(e), "triangle-alert"); } };
  return (
    <div data-screen="nur/ward" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0, flex: 1 }}>{N("board_title")}</h1>
        <div style={{ minWidth: 220 }}>
          <SelectField label={N("ward")} value={wardId ?? ""} onChange={(e) => pick(e.target.value)} data-testid="ward-pick">
            {wards.wards.map((w) => <option key={w.id} value={w.id}>{bn ? w.nameBn ?? w.name : w.name} · {s.n(w.occupied)}/{s.n(w.beds)}</option>)}
          </SelectField>
        </div>
      </div>
      {!board ? <div aria-busy="true" className="t-muted">{N("loading")}</div> : (<>
        <span className="t-small t-muted" data-testid="occupancy">{N("beds_occupied", { occ: occupied, n: board.beds.length })} · {N("sample_rule")}: NEWS2 ≥ {s.n(board.rule.threshold)}</span>
        {board.escalations.map((x) => (
          <Callout key={x.escalation.id} tone="bad" icon="siren" data-testid="escalation-banner" data-escalation={x.escalation.id} data-escalation-status={x.escalation.status}>
            <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <b style={{ flex: 1 }}>{N("escalation_banner", { bed: x.bed, name: name(x.patient, bn), n: x.escalation.peakScore })}</b>
              {x.escalation.status === "raised"
                ? <Button size="sm" variant="primary" icon="phone" onClick={() => setInform(x.escalation)} data-testid="log-inform">{N("log_inform")}</Button>
                : <Pill tone="info" icon="phone">{N("escalation_informed")} · {x.escalation.spokeTo}</Pill>}
              <Button size="sm" icon="heart-pulse" onClick={() => go("nur/vitals", x.encounterId)}>{N("open_vitals")}</Button>
            </span>
          </Callout>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 14, alignItems: "start" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }} data-testid="ward-board">
            {board.beds.map((b) => <BedCard key={b.bed.id} b={b} go={go} onArrive={arrive} />)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <StockPanel wardId={board.ward.id} />
          </div>
        </div>
      </>)}
      {inform && <InformDialog esc={inform} onClose={() => setInform(null)} onDone={async () => { setInform(null); toast(N("escalation_informed"), "phone"); await load(); }} />}
    </div>
  );
}

function BedCard({ b, go, onArrive }: { b: WardBoardBed; go: (screen: string, enc: string) => void; onArrive: (admissionId: string) => void }) {
  const s = useSession(); const N = useN(); const L = useLabels(); const bn = s.lang === "bn";
  const p = b.patient;
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12, borderColor: b.escalation ? "var(--danger-border)" : undefined }} data-bed={b.bed.name} data-bed-state={b.bed.state} data-bed-patient={p?.facilityNo ?? ""}>
      <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <b className="num">{b.bed.name}</b>
        {p ? <span className="t-small t-muted">{b.day != null ? N("day_n", { n: b.day }) : ""}</span> : <Pill tone="neu">{s.t("ipdApp", `st_${b.bed.state}`)}</Pill>}
      </span>
      {p ? (<>
        <b>{name(p, bn)}</b>
        <span className="t-small t-muted num">{p.facilityNo} · {L.age(p)} {L.sex(p.sex)}{b.admissionNumber ? ` · ${b.admissionNumber}` : ""}</span>
        {b.doctor && <span className="t-small">{bn ? b.doctor.nameBn : b.doctor.nameEn}</span>}
        <span className="t-small" data-allergies={b.allergies === null ? "unknown" : b.allergies.length}>
          {b.allergies === null ? <Pill tone="warn" icon="circle-help">{N("allergies_unknown")}</Pill> : b.allergies.length === 0 ? <span className="t-muted">{N("allergies_none")}</span> : <Pill tone="crit" icon="triangle-alert">{b.allergies.join(", ")}</Pill>}
        </span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <News2Pill n={b.news2} />
          {b.obsOverdue ? <span data-obs="overdue"><Pill tone="bad" icon="clock-alert">{N("obs_overdue")}</Pill></span> : b.nextObsDueAt ? <span data-obs="due"><Pill tone="neu" icon="clock">{N("obs_due", { t: hhmm(b.nextObsDueAt, s.numerals === "bn") })}</Pill></span> : null}
          {b.doses.overdue > 0 && <span data-doses-overdue={b.doses.overdue}><Pill tone="bad" icon="pill">{N("doses_overdue", { n: b.doses.overdue })}</Pill></span>}
          {b.doses.due > 0 && <span data-doses-due={b.doses.due}><Pill tone="warn" icon="pill">{N("doses_due", { n: b.doses.due })}</Pill></span>}
        </span>
        {b.encounterId && (
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            <Button size="sm" icon="heart-pulse" onClick={() => go("nur/vitals", b.encounterId!)} data-testid="open-vitals">{N("open_vitals")}</Button>
            <Button size="sm" icon="pill" onClick={() => go("nur/mar", b.encounterId!)} data-testid="open-mar">{N("open_mar")}</Button>
            <Button size="sm" icon="notebook-pen" onClick={() => go("nur/io", b.encounterId!)} data-testid="open-notes">{N("open_notes")}</Button>
            <Button size="sm" icon="move-right" onClick={() => go("ipd/transfer", b.encounterId!)} data-testid="open-move">{N("open_move")}</Button>
          </span>
        )}
      </>) : b.arriving ? (
        <span style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="arriving">
          <span className="t-small">{N("arriving", { name: name(b.arriving.patient, bn), from: b.arriving.fromBed })}</span>
          <Button size="sm" variant="primary" icon="badge-check" onClick={() => onArrive(b.arriving!.admissionId)} data-testid="arrived">{N("arrived")}</Button>
        </span>
      ) : <span className="t-small t-muted">{b.bed.note ?? N("bed_empty")}</span>}
    </Card>
  );
}

function InformDialog({ esc, onClose, onDone }: { esc: Escalation; onClose: () => void; onDone: () => Promise<void> }) {
  const N = useN(); const err = useErr(); const s = useSession();
  const [spokeTo, setSpokeTo] = useState(""); const [instruction, setInstruction] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const blocked = informBlockers({ spokeTo, instruction }).length > 0;
  const go = async () => {
    if (blocked || busy) return; setBusy(true); setMsg(null);
    try { await ward.inform(esc.id, { spokeTo: spokeTo.trim(), instruction: instruction.trim() }); await onDone(); } catch (e) { setMsg(err(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} label={N("inform_title")} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 20 }} data-testid="inform-dialog">
        <b>{N("inform_title")}</b>
        <TextField label={N("spoke_to")} value={spokeTo} onChange={(e) => setSpokeTo(e.target.value)} name="spokeTo" autoFocus />
        <TextArea label={N("instruction")} value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} name="instruction" />
        {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{N("cancel")}</Button>
          <Button variant="primary" icon="phone" disabled={blocked || busy || !s.online} onClick={() => void go()} data-testid="inform-save">{N("log_inform")}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Ward stock and indents: what is on the ward, what was asked of the pharmacy and what came. */
function StockPanel({ wardId }: { wardId: string }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [stock, setStock] = useState<WardStock | null>(null); const [indents, setIndents] = useState<IndentList | null>(null);
  const [adding, setAdding] = useState(false); const [cancelling, setCancelling] = useState<string | null>(null); const [reason, setReason] = useState("");
  const load = useCallback(async () => { try { const [a, b] = await Promise.all([ward.stock(wardId), ward.indents(wardId)]); setStock(a); setIndents(b); } catch { /* the board shows the error */ } }, [wardId]);
  useEffect(() => { void load(); }, [load]);
  const cancel = async (id: string) => {
    if (reason.trim().length < 5) return;
    try { await ward.cancelIndent(id, reason.trim()); setCancelling(null); setReason(""); await load(); } catch (e) { toast(err(e), "triangle-alert"); }
  };
  return (<>
    <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }} data-testid="ward-stock">
      <b>{N("stock_title")}</b>
      {stock && stock.items.length === 0 && <span className="t-small t-muted">{N("stock_empty")}</span>}
      {stock?.items.map((i) => (
        <span key={i.medicineKey} className="t-small" data-stock={i.medicineKey} data-stock-qty={i.qty} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
          <span>{i.name}{i.controlled ? <> · <Pill tone="crit">{N("controlled")}</Pill></> : null}</span><b className="num">{s.n(i.qty)} {i.issueUnit}</b>
        </span>
      ))}
    </Card>
    <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-testid="indents">
      <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>{N("indent_title")}</b>
        {!adding && <Button size="sm" icon="plus" onClick={() => setAdding(true)} disabled={!s.online} data-testid="indent-new">{N("indent_new")}</Button>}</span>
      {adding && <IndentForm wardId={wardId} onDone={async (n) => { setAdding(false); if (n) toast(N("indent_sent", { n }), "send"); await load(); }} />}
      {indents && indents.items.length === 0 && <span className="t-small t-muted">{N("indent_none")}</span>}
      {indents?.items.map((x) => (
        <div key={x.id} className="card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }} data-indent={x.number} data-indent-status={x.status}>
          <span style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><b className="num">{x.number}</b><Pill tone={x.status === "issued" ? "ok" : x.status === "cancelled" ? "off" : "pend"}>{N(`ist_${x.status}`)}</Pill></span>
          {x.lines.map((l) => <span key={l.id} className="t-small num">{N("indent_line", { name: l.name, req: l.requested, iss: l.issued })}</span>)}
          <span className="t-small t-muted">{s.lang === "bn" ? x.requestedBy.nameBn : x.requestedBy.nameEn} · {hhmm(x.requestedAt, s.numerals === "bn")}</span>
          {(x.status === "requested" || x.status === "partially-issued") && cancelling !== x.id && <div><Button size="sm" icon="x" onClick={() => { setCancelling(x.id); setReason(""); }} disabled={!s.online} data-testid="indent-cancel">{N("indent_cancel")}</Button></div>}
          {cancelling === x.id && (
            <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
              <TextField label={N("reason")} value={reason} onChange={(e) => setReason(e.target.value)} name="indentCancelReason" />
              <Button size="sm" variant="danger" disabled={reason.trim().length < 5 || !s.online} onClick={() => void cancel(x.id)} data-testid="indent-cancel-confirm">{N("indent_cancel")}</Button>
            </div>
          )}
        </div>
      ))}
    </Card>
  </>);
}

function IndentForm({ wardId, onDone }: { wardId: string; onDone: (number: string | null) => Promise<void> }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const [meds, setMeds] = useState<{ key: string; brand: string; strength: string; issueUnit: string; controlled: boolean }[]>([]);
  const [lines, setLines] = useState<{ medicineKey: string; qty: string }[]>([{ medicineKey: "", qty: "" }]);
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  useEffect(() => { ward.medicines("").then((r) => setMeds(r.items)).catch(() => setMeds([])); }, []);
  const parsed = lines.filter((l) => l.medicineKey).map((l) => ({ medicineKey: l.medicineKey, qty: Number(l.qty) }));
  const ok = parsed.length > 0 && parsed.every((l) => Number.isInteger(l.qty) && l.qty > 0 && l.qty <= 500) && new Set(parsed.map((l) => l.medicineKey)).size === parsed.length;
  const send = async () => {
    if (!ok || busy) return; setBusy(true); setMsg(null);
    try { const v = await ward.indent(wardId, { lines: parsed, note: note.trim() || undefined }, key.current); await onDone(v.number); }
    catch (e) { key.current = crypto.randomUUID(); setMsg(err(e)); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="indent-form">
      {lines.map((l, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px", gap: 6 }}>
          <SelectField label={N("indent_medicine")} value={l.medicineKey} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, medicineKey: e.target.value } : x)))} data-testid="indent-medicine">
            <option value="">—</option>
            {meds.map((m) => <option key={m.key} value={m.key}>{m.brand} {m.strength}{m.controlled ? ` · ${N("controlled")}` : ""}</option>)}
          </SelectField>
          <TextField label={N("indent_qty")} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x)))} inputMode="numeric" data-testid="indent-qty" />
        </div>
      ))}
      <div><Button size="sm" icon="plus" onClick={() => setLines([...lines, { medicineKey: "", qty: "" }])}>{N("indent_add_line")}</Button></div>
      <TextField label={N("indent_note")} value={note} onChange={(e) => setNote(e.target.value)} />
      {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Button size="sm" onClick={() => void onDone(null)}>{N("cancel")}</Button>
        <Button size="sm" variant="primary" icon="send" disabled={!ok || busy || !s.online} onClick={() => void send()} data-testid="indent-send">{N("indent_send")}</Button>
      </div>
    </div>
  );
}
