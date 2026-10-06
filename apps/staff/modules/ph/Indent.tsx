"use client";
/* ph/indent — walkthrough B5 (ward stock). The wards' indents for the pharmacist: open first, each line with what the
   store holds; Issue moves stock store → ward as a two-leg transfer in one transaction (FEFO batches), and a line of a
   controlled drug needs the pharmacist's PIN (its register line is written with the issue). Issue up to what was asked
   and what the store holds; the balance can be issued later or cancelled by the ward. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { IndentList, IndentView } from "@setu/contracts";
import { format } from "@setu/domain";
import { Button, Callout, Card, Pill, Segmented, TextField, useToast } from "@setu/ui";
import { ApiFailure, ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { PinSheet, hhmm, printLabels, useErr, useN } from "../nur/common";

type Filter = "open" | "issued" | "cancelled";

export function PhIndent() {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [filter, setFilter] = useState<Filter>("open");
  const [list, setList] = useState<IndentList | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      if (filter === "open") { const [a, b] = await Promise.all([ward.pharmacyIndents("requested"), ward.pharmacyIndents("partially-issued")]); setList({ items: [...a.items, ...b.items].sort((x, y) => x.requestedAt.localeCompare(y.requestedAt)) }); }
      else setList(await ward.pharmacyIndents(filter));
      setFailed(null);
    } catch (e) { setFailed(err(e)); }
  }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  return (
    <div data-screen="ph/indent" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 900 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("ph_indent_title")}</h1>
      <Segmented value={filter} options={(["open", "issued", "cancelled"] as Filter[]).map((f) => ({ value: f, label: N(`filter_${f}`) }))} onChange={(f) => setFilter(f as Filter)} label={N("ph_indent_title")} />
      {failed && <Callout tone="warn" icon="triangle-alert">{failed}</Callout>}
      {!list ? <div aria-busy="true" className="t-muted">{N("loading")}</div> : list.items.length === 0 ? <span className="t-small t-muted">{N("indent_none")}</span>
        : list.items.map((x) => <IndentCard key={x.id} x={x} onIssued={async (v) => { toast(N("issued_toast", { n: v.number }), "package-check"); await load(); }} />)}
      {!s.online && <span className="t-small t-muted">{N("needs_connection")}</span>}
    </div>
  );
}

function IndentCard({ x, onIssued }: { x: IndentView; onIssued: (v: IndentView) => Promise<void> }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const open = x.status === "requested" || x.status === "partially-issued";
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(x.lines.map((l) => [l.id, String(Math.max(0, Math.min(l.requested - l.issued, l.storeAvailable)))])));
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [pin, setPin] = useState(false);
  const key = useRef(crypto.randomUUID());
  const lines = x.lines.map((l) => ({ l, q: Number(qty[l.id] ?? 0) })).filter(({ q }) => q > 0);
  const valid = lines.length > 0 && lines.every(({ l, q }) => Number.isInteger(q) && q <= l.requested - l.issued && q <= l.storeAvailable);
  const controlled = lines.some(({ l }) => l.controlled);
  const issue = async (p?: string) => {
    setBusy(true); setMsg(null);
    try { const v = await ward.issue(x.id, { lines: lines.map(({ l, q }) => ({ lineId: l.id, qty: q })), pin: p }, key.current); key.current = crypto.randomUUID(); setPin(false); await onIssued(v); }
    catch (e) {
      if (e instanceof ApiFailure && (e.body.code === "pin_wrong" || e.body.code === "pin_locked")) throw e;
      if (e instanceof ApiFailure) key.current = crypto.randomUUID();
      setPin(false); setMsg(err(e));
    } finally { setBusy(false); }
  };
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-indent={x.number} data-indent-status={x.status}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b className="num">{x.number}</b><span>{x.ward.name}</span>
        <Pill tone={x.status === "issued" ? "ok" : x.status === "cancelled" ? "off" : "pend"}>{N(`ist_${x.status}`)}</Pill>
        <span className="t-small t-muted">{s.lang === "bn" ? x.requestedBy.nameBn : x.requestedBy.nameEn} · {hhmm(x.requestedAt, s.numerals === "bn")}</span>
      </span>
      {x.note && <span className="t-small">{x.note}</span>}
      {x.lines.map((l) => (
        <div key={l.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 110px", gap: 8, alignItems: "end" }} data-indent-line={l.medicineKey}>
          <span className="t-small" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span>{N("indent_line", { name: l.name, req: l.requested, iss: l.issued })} {l.issueUnit}</span>
            <span className="t-muted">{N("store_n", { n: l.storeAvailable })}</span>
            {l.controlled && <Pill tone="crit" icon="lock">{N("controlled")}</Pill>}
          </span>
          {open && l.issued < l.requested && <TextField label={N("issue_qty")} value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: format.toEn(e.target.value).replace(/\D/g, "") })} inputMode="numeric" data-testid="issue-qty" />}
        </div>
      ))}
      {x.cancel && <span className="t-small t-muted">{N("ist_cancelled")}: {x.cancel.reason}</span>}
      {x.issues.some((i) => i.label) && <div><Button size="sm" icon="tag" onClick={() => void printLabels([...new Set(x.issues.flatMap((i) => (i.label ? [i.label.slice(9)] : [])))], N("labels_print"), N("label_exp_short")).then((ok) => { if (!ok) toast(N("print_blocked"), "printer"); }).catch((e) => toast(err(e), "triangle-alert"))} data-testid="issue-labels">{N("labels_print")}</Button></div>}
      {msg && <Callout tone="warn" icon="triangle-alert" data-testid="issue-error">{msg}</Callout>}
      {open && <div><Button variant="primary" icon="package-check" disabled={!valid || busy || !s.online} onClick={() => (controlled ? setPin(true) : void issue())} data-testid="issue">{N("issue")}</Button></div>}
      {pin && <PinSheet title={N("controlled_pin")} action={N("issue")} icon="package-check" onClose={() => setPin(false)} submit={(p) => issue(p)} />}
    </Card>
  );
}
