"use client";
/* ipd/transfer — walkthrough B4 (bed move). The two-leg move: the new bed reserved (leg 1), then the patient arrives
   (leg 2, the old bed goes to cleaning). "Move now" does both in one transaction; "Reserve" waits for the ward to
   confirm arrival (or cancel). The reason is required, the handover note goes on the nursing notes. The daily price
   difference is shown as a sample — the IPD bill is not touched here (slice B8). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { BedBoard, BedView } from "@setu/contracts";
import { bedPickable, format } from "@setu/domain";
import { Button, Callout, Card, PageState, Segmented, TextArea, useToast } from "@setu/ui";
import { ApiFailure, ipd, ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useErr, useLabels, useN } from "../nur/common";
import { toBanner } from "../fd/common";
import { BedPicker, type PickBed } from "./BedPicker";

export function IpdTransfer() {
  const s = useSession(); const N = useN(); const err = useErr(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const enc = useSearchParams().get("enc");
  const [board, setBoard] = useState<BedBoard | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(async () => { try { setBoard(await ipd.beds()); } catch (e) { setFailed(err(e)); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const all = useMemo(() => board?.wards.flatMap((w) => w.beds) ?? [], [board]);
  const current = all.find((b) => b.assignment?.status === "occupied" && b.assignment.encounterId === enc) ?? null;
  const pending = all.find((b) => b.assignment?.status === "reserved" && b.assignment.encounterId === enc) ?? null;
  useEffect(() => {
    if (!current?.patient) { s.setPatient(null); return; }
    s.setPatient({ ...toBanner(current.patient, `${L.age(current.patient)} ${L.sex(current.patient.sex)}`), location: `${s.lang === "bn" ? current.ward.nameBn ?? current.ward.name : current.ward.name} · ${current.name}` });
  }, [current?.id, s.lang]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!board) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bn = s.lang === "bn";
  if (!enc || !current) {
    const occupied = all.filter((b) => b.assignment?.status === "occupied" && b.bedClass !== "ER");
    return (
      <div data-screen="ipd/transfer" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{N("move_title")}</h1>
        <span className="t-small t-muted">{N("pick_patient")}</span>
        {occupied.length === 0 && <PageState icon="bed-double" title={N("move_title")} body={N("rounds_none")} />}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
          {occupied.map((b) => (
            <button key={b.id} type="button" className="card" data-pick-bed={b.name} onClick={() => router.push(`/m/ipd/transfer?enc=${encodeURIComponent(b.assignment!.encounterId)}`)} style={{ textAlign: "left", padding: 12, display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }}>
              <b className="num">{bn ? b.ward.nameBn ?? b.ward.name : b.ward.name} · {b.name}</b><span>{bn ? b.patient?.nameBn : b.patient?.nameEn || b.patient?.nameBn}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return <MoveForm key={current.id} board={board} current={current} pending={pending} onDone={async (m) => { toast(m, "badge-check"); await load(); }} />;
}

function MoveForm({ board, current, pending, onDone }: { board: BedBoard; current: BedView; pending: BedView | null; onDone: (msg: string) => Promise<void> }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const wn = (b: BedView) => (s.lang === "bn" ? b.ward.nameBn ?? b.ward.name : b.ward.name);
  const admissionId = current.assignment?.admissionId ?? "";
  const patientId = current.patient?.id ?? "";
  const [cls, setCls] = useState(current.bedClass); const [bedId, setBedId] = useState<string | null>(null);
  const [reason, setReason] = useState(""); const [handover, setHandover] = useState(""); const [mode, setMode] = useState<"now" | "reserve">("now");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [cancelReason, setCancelReason] = useState("");
  const key = useRef(crypto.randomUUID());
  const beds: PickBed[] = board.wards.flatMap((w) => w.beds.filter((b) => b.bedClass !== "ER" && b.id !== current.id).map((b) => {
    const p = bedPickable({ state: b.state, bedClass: b.bedClass, reservedForPatientId: null }, patientId);
    return { id: b.id, name: b.name, ward: w.name, wardBn: w.nameBn, bedClass: b.bedClass, state: b.state, pickable: p.ok, reason: p.ok ? null : p.reason };
  }));
  const chosen = beds.find((b) => b.id === bedId);
  const rate = (c: string) => board.classes.find((x) => x.key === c)?.perDayPaisa ?? 0;
  const diff = chosen ? rate(chosen.bedClass) - rate(current.bedClass) : 0;
  const ok = !!chosen && reason.trim().length >= 5 && !!admissionId && s.online && !busy && !pending;
  const run = async (f: () => Promise<string>) => { setBusy(true); setMsg(null); try { await onDone(await f()); } catch (e) { if (e instanceof ApiFailure) key.current = crypto.randomUUID(); setMsg(err(e)); } finally { setBusy(false); } };
  const move = () => run(async () => {
    const v = await ward.move(admissionId, { bedId: chosen!.id, reason: reason.trim(), handoverNote: handover.trim() || undefined, mode }, key.current);
    key.current = crypto.randomUUID();
    return mode === "now" ? N("moved", { bed: v.bed.name }) : N("reserved", { bed: chosen!.name });
  });
  return (
    <div data-screen="ipd/transfer" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("move_title")}</h1>
      <span data-testid="move-from">{N("move_from", { bed: `${wn(current)} · ${current.name}` })}</span>
      {pending && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-testid="move-pending">
          <b>{N("reserved", { bed: `${wn(pending)} · ${pending.name}` })}</b>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <Button variant="primary" icon="badge-check" disabled={busy || !s.online} onClick={() => void run(async () => { const v = await ward.arrive(admissionId); return N("moved", { bed: v.bed.name }); })} data-testid="move-arrive">{N("arrived")}</Button>
            <TextArea label={N("reason")} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={1} name="cancelReason" />
            <Button icon="undo-2" disabled={busy || cancelReason.trim().length < 5 || !s.online} onClick={() => void run(async () => { await ward.cancelMove(admissionId, cancelReason.trim()); return N("cancel_move"); })} data-testid="move-cancel">{N("cancel_move")}</Button>
          </div>
        </Card>
      )}
      {!pending && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }} data-testid="move-form">
          <BedPicker beds={beds} value={bedId} onPick={setBedId} classes={board.classes} cls={cls} onClass={setCls} />
          {chosen && diff !== 0 && <span className="t-small t-muted" data-testid="price-diff">{N("price_diff", { amount: `${diff > 0 ? "+" : "−"}${format.takaFromPaisa(Math.abs(diff), { bn: s.numerals === "bn" })}` })}</span>}
          <TextArea label={N("move_reason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} name="moveReason" data-testid="move-reason" />
          <TextArea label={N("handover")} value={handover} onChange={(e) => setHandover(e.target.value)} rows={2} name="handover" />
          <Segmented value={mode} options={[{ value: "now", label: N("move_now") }, { value: "reserve", label: N("move_reserve") }]} onChange={(m) => setMode(m as "now" | "reserve")} label={N("move_title")} />
          {msg && <Callout tone="warn" icon="triangle-alert" data-testid="move-error">{msg}</Callout>}
          <div><Button variant="primary" icon="move-right" disabled={!ok} onClick={() => void move()} data-testid="move-submit">{mode === "now" ? N("move_now") : N("move_reserve")}</Button>
            {!s.online && <span className="t-small t-muted"> {N("needs_connection")}</span>}</div>
        </Card>
      )}
    </div>
  );
}
