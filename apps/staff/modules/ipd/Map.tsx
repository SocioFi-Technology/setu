"use client";
/* ipd/map — walkthrough B4 (bed moves start here). Ported from docs/prototype/Setu IPD.dc.html (screen "map"): every
   ward bed with its state written on the card (never colour alone), the legend with counts, filters by ward and state;
   a bed opens its actions — block with a reason, unblock, mark ready after cleaning — and an occupied bed links to the
   bed move. Bed states change only through BED on the server. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { BedBoard, BedView } from "@setu/contracts";
import { Button, Callout, Card, Pill, SelectField, TextField, useToast } from "@setu/ui";
import { ipd } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useErr, useLabels, useN } from "../nur/common";
import { BED_TONE } from "./BedPicker";

const STATES = ["vacant", "reserved", "occupied", "discharge-pending", "cleaning", "blocked"] as const;

export function IpdMap() {
  const s = useSession(); const N = useN(); const err = useErr(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const [board, setBoard] = useState<BedBoard | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const [wardF, setWardF] = useState(""); const [stateF, setStateF] = useState("");
  const [sel, setSel] = useState<BedView | null>(null); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const b = await ipd.beds(); setBoard(b); setSel((x) => (x ? b.wards.flatMap((w) => w.beds).find((y) => y.id === x.id) ?? null : null)); } catch (e) { setFailed(err(e)); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!board) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bn = s.lang === "bn";
  const count = (st: string) => (st === "discharge-pending" ? board.counts.dischargePending : board.counts[st as keyof BedBoard["counts"]]);
  const wards = board.wards.filter((w) => w.beds.some((b) => b.bedClass !== "ER")).filter((w) => !wardF || w.id === wardF);
  const act = async (action: "block" | "unblock" | "markReady") => {
    if (!sel || busy) return; setBusy(true);
    try { await ipd.bedAction(sel.id, { action, reason: action === "block" ? reason.trim() : undefined }, crypto.randomUUID()); setReason(""); await load(); }
    catch (e) { toast(err(e), "triangle-alert"); } finally { setBusy(false); }
  };
  return (
    <div data-screen="ipd/map" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("map_title")}</h1>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} data-testid="legend">
        <span className="t-small t-secondary">{N("legend")}:</span>
        {STATES.map((st) => <span key={st} data-legend={st} data-count={count(st)}><Pill tone={BED_TONE[st] ?? "neu"}>{N(`bst_${st}`)} · {s.n(count(st))}</Pill></span>)}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ minWidth: 200 }}><SelectField label={N("ward")} value={wardF} onChange={(e) => setWardF(e.target.value)} data-testid="map-ward">
          <option value="">{N("all_wards")}</option>
          {board.wards.filter((w) => w.beds.some((b) => b.bedClass !== "ER")).map((w) => <option key={w.id} value={w.id}>{bn ? w.nameBn ?? w.name : w.name}</option>)}
        </SelectField></div>
        <div style={{ minWidth: 200 }}><SelectField label={N("legend")} value={stateF} onChange={(e) => setStateF(e.target.value)} data-testid="map-state">
          <option value="">{N("all_states")}</option>
          {STATES.map((st) => <option key={st} value={st}>{N(`bst_${st}`)}</option>)}
        </SelectField></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: sel ? "repeat(auto-fit, minmax(320px, 1fr))" : "minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {wards.map((w) => (
            <div key={w.id} style={{ display: "flex", flexDirection: "column", gap: 6 }} data-map-ward={w.name}>
              <b>{bn ? w.nameBn ?? w.name : w.name}</b>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
                {w.beds.filter((b) => b.bedClass !== "ER" && (!stateF || b.state === stateF)).map((b) => (
                  <button key={b.id} type="button" className="card" data-bed={b.name} data-bed-state={b.state} aria-pressed={sel?.id === b.id} onClick={() => setSel(b)}
                    style={{ textAlign: "left", padding: 10, display: "flex", flexDirection: "column", gap: 4, cursor: "pointer", outline: sel?.id === b.id ? "2px solid var(--brand-primary)" : undefined }}>
                    <span style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><b className="num">{b.name}</b><Pill tone={BED_TONE[b.state] ?? "neu"}>{N(`bst_${b.state}`)}</Pill></span>
                    <span className="t-small t-muted">{b.bedClass}</span>
                    {b.patient && <span className="t-small">{bn ? b.patient.nameBn : b.patient.nameEn || b.patient.nameBn}</span>}
                    {b.note && <span className="t-small t-muted">{b.note}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {sel && (
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-testid="bed-panel">
            <b className="num">{sel.name} · {N(`bst_${sel.state}`)}</b>
            <span className="t-small t-muted">{sel.ward.name} · {sel.bedClass}</span>
            {sel.patient && <span className="t-small">{bn ? sel.patient.nameBn : sel.patient.nameEn || sel.patient.nameBn} · <span className="num">{sel.patient.facilityNo}</span> · {L.age(sel.patient)} {L.sex(sel.patient.sex)}</span>}
            {sel.state === "vacant" && (<>
              <TextField label={N("block_reason")} value={reason} onChange={(e) => setReason(e.target.value)} name="blockReason" />
              <div><Button icon="ban" disabled={busy || reason.trim().length < 3 || !s.online} onClick={() => void act("block")} data-testid="bed-block">{N("block")}</Button></div>
            </>)}
            {sel.state === "blocked" && <div><Button icon="circle-check" disabled={busy || !s.online} onClick={() => void act("unblock")} data-testid="bed-unblock">{N("unblock")}</Button></div>}
            {sel.state === "cleaning" && <div><Button variant="primary" icon="sparkles" disabled={busy || !s.online} onClick={() => void act("markReady")} data-testid="bed-ready">{N("mark_ready")}</Button></div>}
            {sel.state === "occupied" && sel.assignment && <div><Button icon="move-right" onClick={() => router.push(`/m/ipd/transfer?enc=${encodeURIComponent(sel.assignment!.encounterId)}`)} data-testid="bed-move">{N("move_title")}</Button></div>}
          </Card>
        )}
      </div>
    </div>
  );
}
