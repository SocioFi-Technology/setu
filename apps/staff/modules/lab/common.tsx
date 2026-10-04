"use client";
/* Shared by the lab screens (slice A8–A11): strings, names and times, flags as text + icon (never colour alone), the
   range with its label ("adult female range", decision D1), the patient banner, the visit loader, reason dialogs.
   Every rule (flags, delta, what may be verified / validated / released) comes from @setu/domain or the server. */
import { SMS_MAYBE_SENT } from "@setu/domain";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { LabResult, LabVisitView } from "@setu/contracts";
import { TUBES, format, labRoleCan, type LabFlag, type TubeKind } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Dialog, Pill, type Tone } from "@setu/ui";
import { ApiFailure, lab } from "../../lib/api";
import { useSession } from "../../lib/session";
import { toBanner, useLabels } from "../fd/common";

/** Lab strings: `T("key", { n })` from the labApp namespace; numbers in vars follow the numerals toggle. */
export function useLb() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("labApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function useFmt() {
  const s = useSession();
  const bn = s.numerals === "bn";
  return {
    name: (p: { nameBn: string; nameEn: string | null } | null | undefined) => (p ? (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn) : "—"),
    test: (o: { nameBn: string; nameEn: string }) => (s.lang === "bn" ? o.nameBn : o.nameEn),
    time: (iso: string | null | undefined) => (iso ? format.time(iso, bn) : "—"),
    date: (iso: string | null | undefined) => (iso ? format.date(iso, bn) : "—"),
    dateTime: (iso: string | null | undefined) => (iso ? format.dateTime(iso, bn) : "—"),
    /** a measured value with the analyte's decimals, in the chosen numerals */
    value: (v: number, decimals: number) => s.n(v.toFixed(Math.max(0, Math.min(3, decimals)))),
    pct: (p: number) => s.n(`${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}%`),
  };
}
/** The server's message in the chosen language. */
export function useErr() {
  const s = useSession(); const T = useLb();
  return (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("error_generic"));
}

const FLAG: Record<LabFlag, { tone: Tone; icon: string }> = {
  HH: { tone: "crit", icon: "siren" }, LL: { tone: "crit", icon: "siren" }, H: { tone: "high", icon: "arrow-up" }, L: { tone: "high", icon: "arrow-down" }, N: { tone: "ok", icon: "check" },
};
/** H / L / HH / LL as text + icon; null = no range in the sample list (and not critical). */
export function FlagPill({ flag }: { flag: LabFlag | null }) {
  const T = useLb();
  if (!flag) return <span className="t-small t-muted" data-flag="none">{T("flag_none")}</span>;
  return <span data-flag={flag}><Pill tone={FLAG[flag].tone} icon={FLAG[flag].icon}>{T(`flag_${flag}`)}</Pill></span>;
}
/** "12.0–15.5 g/dL · adult female range" — the label is always shown next to the range (decision D1). */
export function RangeText({ range, unit, decimals }: { range: { low: number; high: number; label: string } | null; unit?: string; decimals: number }) {
  const T = useLb(); const F = useFmt();
  if (!range) return <span className="t-small t-muted" data-range="none">{T("range_none")}</span>;
  return (
    <span className="t-small" data-range={range.label}>
      <span className="num">{F.value(range.low, decimals)}–{F.value(range.high, decimals)}</span>{unit ? ` ${unit}` : ""} · <b>{T(`range_${range.label}`)}</b>
    </span>
  );
}
export const RESULT_TONE: Record<LabResult["status"], Tone> = { preliminary: "draft", verified: "pend", final: "final", amended: "info", "entered-in-error": "off" };
export const REPORT_TONE: Record<string, Tone> = { preliminary: "warn", final: "final", corrected: "info", superseded: "off" };
export const COMM_TONE: Record<string, Tone> = { preparation: "pend", "in-progress": "pend", completed: "ok", failed: "bad" };
/** ADR 0012: an SMS the gateway only accepted is "Sent", never "Delivered" */
export const csKey = (c: { status: string; channel: string; deliveryConfirmed: boolean; lastError?: string | null }) =>
  c.status === "completed" && c.channel === "sms" && !c.deliveryConfirmed ? "cs_sent" : c.status === "failed" && c.lastError === SMS_MAYBE_SENT ? "cs_maybe_sent" : `cs_${c.status}`;
/** "Sent" without a delivery report is not the green of "Delivered" (controls review) */
export const commTone = (c: { status: string; channel: string; deliveryConfirmed: boolean }): Tone => (c.status === "completed" && c.channel === "sms" && !c.deliveryConfirmed ? "info" : COMM_TONE[c.status] ?? "neu");
export const SPECIMEN_TONE: Record<string, Tone> = { pending: "neu", collected: "info", received: "info", "in-process": "pend", done: "ok", rejected: "bad" };
export const COLLECTION_TONE: Record<string, Tone> = { none: "off", pending: "neu", partial: "warn", collected: "ok", rejected: "bad" };
const TUBE_COLOUR: Record<string, string> = { purple: "#7c3aed", grey: "#9ca3af", red: "#dc2626", none: "transparent" };
export function TubeDot({ tube }: { tube: TubeKind }) {
  const c = TUBES[tube].colour;
  return <span aria-hidden style={{ width: 14, height: 14, borderRadius: 999, flex: "none", display: "inline-block", background: TUBE_COLOUR[c], border: "2px solid var(--border-default)" }} />;
}

/** Loads one visit for the lab screens, sets the patient banner, and lets the screen replace it with a write's answer. */
export function useLabVisit(encounterId: string) {
  const s = useSession(); const L = useLabels();
  const [v, setV] = useState<LabVisitView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const show = useCallback((x: LabVisitView) => {
    setV(x);
    s.setPatient(toBanner(x.patient, `${L.age(x.patient)} ${L.sex(x.patient.sex)}`));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    try { show(await lab.visit(encounterId)); setFailed(null); }
    catch (e) { setFailed(e instanceof ApiFailure && e.status === 404 ? "not_found" : "error"); }
  }, [encounterId, show]);
  useEffect(() => { setV(null); void reload(); return () => s.setPatient(null); }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  // the banner follows the language and numerals toggles
  useEffect(() => { if (v) s.setPatient(toBanner(v.patient, `${L.age(v.patient)} ${L.sex(v.patient.sex)}`)); }, [s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  return { v, show, reload, failed };
}

/** A dialog asking for a reason of at least `min` characters (send-back, withdraw, cancel order, correction). */
export function ReasonDialog({ open, title, body, label, confirm, min = 10, busy, error, onClose, onConfirm, children, extraValid = true, tone = "danger" }: {
  open: boolean; title: string; body?: ReactNode; label: string; confirm: string; min?: number; busy?: boolean; error?: string | null;
  onClose: () => void; onConfirm: (reason: string) => void; children?: ReactNode; extraValid?: boolean; tone?: "danger" | "primary";
}) {
  const T = useLb();
  const [reason, setReason] = useState("");
  useEffect(() => { if (open) setReason(""); }, [open]);
  const ok = reason.trim().length >= min && extraValid;
  return (
    <Dialog open={open} onClose={onClose} label={title} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
        <h2 className="t-h3" style={{ margin: 0 }}>{title}</h2>
        {body && <span className="t-small">{body}</span>}
        {children}
        <label className="field t-small">{label}
          <textarea className="input" name="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <span className="t-small t-muted">{T("reason_min", { n: min })}</span>
        </label>
        {error && <span className="field-error" role="alert">{error}</span>}
        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{T("cancel")}</Button>
          <Button variant={tone} data-testid="reason-confirm" disabled={!ok || busy} onClick={() => onConfirm(reason.trim())}>{confirm}</Button>
        </span>
      </div>
    </Dialog>
  );
}

/** Screen header: title + the visit line (token, patient no.). */
export function VisitHead({ v, title, right }: { v: LabVisitView; title: string; right?: ReactNode }) {
  const F = useFmt(); const L = useLabels();
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{title}</h1>
      <span className="t-muted num">{v.encounter.token} · {v.patient.facilityNo} · {F.name(v.patient)} · {L.age(v.patient)} {L.sex(v.patient.sex)}</span>
      <span style={{ marginLeft: "auto" }} />
      {right}
    </div>
  );
}
/** Whether the signed-in role may do a lab action (the same LAB_ROLES table the API checks; cancel = the lab's roles). */
export const isLabWriter = (role: string | undefined, action: Parameters<typeof labRoleCan>[0] | "revoke") => labRoleCan(action === "revoke" ? "withdraw" : action, role ?? "");
