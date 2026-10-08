"use client";
/* ph/dispense — journey P1–P3 (ADR 0009). Ported from docs/prototype/Setu Pharmacy.dc.html ("Dispense from
   prescription"). The queue lists today's signed prescriptions; a visit shows each line of the signed, current note:
   what the doctor prescribed, what was already given (from which batch, by whom — prescribed ≠ dispensed ≠ what the
   patient says), the FEFO batches the server proposes (expired ones shown, never given), a same-generic substitute
   with a reason (the doctor is told), decline with a reason, and the Bangla dose label. Dispensing moves stock and
   bills it on the visit's pharmacy bill — only once the server has answered; nothing is shown as given before that. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DispenseLine, DispenseView, InvoiceView } from "@setu/contracts";
import { fill, t as tr } from "@setu/i18n";
import { Button, Callout, Card, Dialog, PageState, Pill, SelectField, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { ApiFailure, bill, pharm } from "../../lib/api";
import { useSession } from "../../lib/session";
import { bannerOf, useLabels } from "../fd/common";
import { BatchState, MedName, NeedsServer, renewKey, toInt, useErr, useFmt, useP } from "./common";
import { printDoseLabels, type DoseLabelData } from "./labels";

const LINE_TONE: Record<DispenseLine["status"], Tone> = { "to-dispense": "pend", partial: "warn", dispensed: "ok", declined: "off", "partial-declined": "off" };
const Q_TONE: Record<string, Tone> = { "to-dispense": "pend", partial: "warn", done: "ok" };

export function PhDispense() {
  const enc = useSearchParams().get("enc");
  return enc ? <Visit encounterId={enc} /> : <Queue />;
}

function Queue() {
  const P = useP(); const F = useFmt(); const router = useRouter();
  const [q, setQ] = useState<Awaited<ReturnType<typeof pharm.queue>> | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { pharm.queue().then(setQ).catch(() => setFailed(true)); }, []);
  if (failed) return <PageState icon="cloud-off" title={P("error_generic")} />;
  if (!q) return <div aria-busy="true" className="t-muted">{P("loading")}</div>;
  return (
    <div data-screen="ph/dispense" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{P("dispense_title")}</h1>
      <span className="t-small t-secondary">{P("queue_sub")}</span>
      {q.items.length === 0 && <PageState icon="pill" title={P("queue_empty")} />}
      {q.items.map((i) => (
        <button key={i.encounter.id} type="button" className="card" data-testid="rx-row" data-encounter={i.encounter.id} data-status={i.status}
          style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, textAlign: "left", cursor: "pointer", flexWrap: "wrap" }}
          onClick={() => router.push(`/m/ph/dispense?enc=${encodeURIComponent(i.encounter.id)}`)}>
          <b className="num">{i.encounter.token}</b>
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <b>{F.name(i.encounter.patient)}</b>
            <span className="t-small t-secondary">{F.name(i.encounter.practitioner)} · {P("signed_at", { t: F.time(i.signedAt) })} · {P("lines_n", { n: i.lineCount })}</span>
          </span>
          {i.bill && <span className="t-small num">{P("bill")}: {F.tk(i.bill.totalPaisa)}</span>}
          {i.takeHome && <span data-testid="take-home"><Pill tone="info" icon="home">{P("take_home")}</Pill></span>}
          <Pill tone={Q_TONE[i.status]}>{P(`q_${i.status}`)}</Pill>
        </button>
      ))}
    </div>
  );
}

/** `seen`: the dispensed quantity the pick was made against — a new answer from the server starts the line afresh */
type LinePick = { on: boolean; medicineKey: string; qty: string; reason: string; seen: number };

function Visit({ encounterId }: { encounterId: string }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const [v, setV] = useState<DispenseView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, LinePick>>({});
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [declining, setDeclining] = useState<DispenseLine | null>(null);
  const [billView, setBillView] = useState<InvoiceView | null>(null);
  const [labelKey, setLabelKey] = useState(() => crypto.randomUUID());

  const show = useCallback((x: DispenseView) => {
    setV(x);
    s.setPatient({ ...bannerOf(x.encounter.patient, L), allergies: x.allergies.map((a) => (s.lang === "bn" ? a.labelBn : a.labelEn)) });
    // what is still open starts ticked, at the rest of the line (the server checks stock and the prescription again)
    setPicks((old) => Object.fromEntries(x.lines.map((l) => {
      const o = old[l.requestId];
      const avail = l.proposal.allocations.reduce((a, b) => a + b.qty, 0);
      return [l.requestId, o && l.remaining > 0 && o.seen === l.dispensedQty ? o : { on: l.remaining > 0 && avail > 0, medicineKey: l.prescribed.key, qty: String(Math.min(l.remaining, avail || l.remaining)), reason: "", seen: l.dispensedQty }];
    })));
  }, [s.lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    try { show(await pharm.visit(encounterId)); setFailed(null); }
    catch (e) { setFailed(e instanceof ApiFailure && e.status === 404 ? "not_found" : "error"); }
  }, [encounterId, show]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (v?.bill) bill.view(v.bill.id).then(setBillView).catch(() => setBillView(null)); else setBillView(null); }, [v?.bill?.id, v?.bill?.totalPaisa, v?.bill?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => (v ? v.lines.filter((l) => picks[l.requestId]?.on && l.remaining > 0) : []), [v, picks]);
  if (failed) return <PageState icon="pill" title={failed === "not_found" ? P("no_prescription") : P("error_generic")} actions={<Button icon="arrow-left" onClick={() => router.push("/m/ph/dispense")}>{P("dispense_title")}</Button>} />;
  if (!v) return <div aria-busy="true" className="t-muted">{P("loading")}</div>;

  const set = (id: string, patch: Partial<LinePick>) => setPicks((p) => ({ ...p, [id]: { ...p[id]!, ...patch } }));
  const invalid = chosen.some((l) => { const p = picks[l.requestId]!; const q = toInt(p.qty); return q === null || q <= 0 || q > l.remaining || (p.medicineKey !== l.prescribed.key && p.reason.trim().length < 10); });
  const dispense = async () => {
    if (busy || !chosen.length || invalid) return;
    setBusy(true);
    try {
      const x = await pharm.dispense(encounterId, { compositionId: v.composition.id, lines: chosen.map((l) => { const p = picks[l.requestId]!; return { requestId: l.requestId, medicineKey: p.medicineKey, qty: toInt(p.qty)!, ...(p.medicineKey !== l.prescribed.key ? { reason: p.reason.trim() } : {}) }; }) }, key);
      show(x); setKey(crypto.randomUUID());
      toast(P("dispensed_ok"), "package-check");
    } catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setKey(crypto.randomUUID()); await load(); }
    finally { setBusy(false); }
  };
  const allClosed = v.lines.every((l) => l.remaining === 0);
  const printable = v.lines.filter((l) => l.given.length > 0 && l.label);
  /** the label of a line as it goes in the bag: what was given (brand, total), the Bangla dose, the batches (Bangla whatever the screen language) */
  const labelOf = (l: DispenseLine): DoseLabelData => {
    const m = l.given[l.given.length - 1]!.medicine;
    return {
      medicine: `${m.brand} ${m.strength}`, qty: s.n(l.given.reduce((a, g) => a + g.qty, 0)), dose: l.label!.bn,
      patient: v.encounter.patient.nameBn, batches: [...new Set(l.given.map((g) => fill(tr("bn", "pharmApp", "label_batch_exp"), { batch: g.batchNo, date: F.day(g.expiry) })))].join(", "),
      facility: v.facility.nameBn ?? v.facility.nameEn, date: F.date(new Date().toISOString()),
    };
  };
  const print = async (lines: DispenseLine[]) => {
    if (busy || !lines.length) return;
    setBusy(true);
    try { await pharm.labels(encounterId, lines.map((l) => l.requestId), labelKey); setLabelKey(crypto.randomUUID()); printDoseLabels(lines.map(labelOf), v.labelPage); }
    catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setLabelKey(crypto.randomUUID()); }
    finally { setBusy(false); }
  };

  return (
    <div data-screen="ph/dispense" data-encounter={encounterId} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{P("dispense_title")}</h1>
        {v.composition.takeHome && <span data-testid="take-home"><Pill tone="info" icon="home">{P("take_home")}</Pill></span>}
        <span className="t-small t-secondary">{F.name(v.encounter.practitioner)} · {P("note_version", { n: v.composition.version })} · {P("signed_at", { t: F.dateTime(v.composition.signedAt) })}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/ph/dispense")}>{P("queue")}</Button>
      </div>
      <NeedsServer />
      {v.allergies.length > 0 && (
        <Callout tone="bad" icon="triangle-alert" data-testid="allergy-strip">{P("allergies")}: {v.allergies.map((a) => (s.lang === "bn" ? a.labelBn : a.labelEn)).join(", ")}</Callout>
      )}
      <Callout tone="info" icon="layers">{P("three_facts")}</Callout>

      {v.lines.map((l) => <LineCard key={l.requestId} l={l} pick={picks[l.requestId]} set={(p) => set(l.requestId, p)} patient={F.name(v.encounter.patient)} onDecline={() => setDeclining(l)} onPrint={l.given.length > 0 && l.label ? () => void print([l]) : undefined} />)}

      <Card style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, flexWrap: "wrap" }}>
        <Button variant="primary" icon="package-check" data-testid="dispense" disabled={!s.online || busy || !chosen.length || invalid} onClick={dispense}>
          {busy ? P("saving") : P("dispense_n", { n: chosen.length })}
        </Button>
        {invalid && <span className="t-small" style={{ color: "var(--danger-fg)" }}>{P("fix_lines")}</span>}
        {allClosed && <Pill tone="ok" icon="check">{P("all_done")}</Pill>}
        <span style={{ marginLeft: "auto" }} />
        {printable.length > 0 && <Button icon="printer" data-testid="print-labels" disabled={!s.online || busy} onClick={() => void print(printable)}>{P("print_labels_n", { n: printable.length, w: v.labelPage.widthMm, h: v.labelPage.heightMm })}</Button>}
      </Card>

      <BillCard v={v} billView={billView} onChanged={load} />

      <Dialog open={!!declining} onClose={() => setDeclining(null)} label={P("decline_title")}>
        {declining && <DeclineForm v={v} l={declining} onDone={(x) => { setDeclining(null); show(x); }} />}
      </Dialog>
    </div>
  );
}

function LineCard({ l, pick, set, patient, onDecline, onPrint }: { l: DispenseLine; pick: LinePick | undefined; set: (p: Partial<LinePick>) => void; patient: string; onDecline: () => void; onPrint?: () => void }) {
  const s = useSession(); const P = useP(); const F = useFmt();
  const open = l.remaining > 0;
  const sub = pick && pick.medicineKey !== l.prescribed.key ? l.substitutes.find((x) => x.medicine.key === pick.medicineKey) : null;
  const avail = l.proposal.allocations.reduce((a, b) => a + b.qty, 0);
  return (
    <Card data-testid="rx-line" data-medicine={l.prescribed.key} data-status={l.status} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <MedName m={l.prescribed} />
        <span className="t-small" style={{ flex: 1, minWidth: 180 }}>{l.label ? (s.lang === "bn" ? l.label.bn : l.label.en) : P("label_unreadable")}</span>
        <span className="t-small num" data-testid="line-qty">{P("prescribed_given", { p: l.quantity, g: l.dispensedQty })}</span>
        <Pill tone={LINE_TONE[l.status]}>{P(`ls_${l.status}`)}</Pill>
      </div>

      {l.given.length > 0 && (
        <ul className="t-small" style={{ margin: 0, paddingLeft: 18 }} data-testid="given">
          {l.given.map((g) => (
            <li key={g.id}>
              <span className="num">{F.n(g.qty)}</span> × {g.medicine.brand} {g.medicine.strength} · {P("batch")} <span className="num">{g.batchNo}</span> · {P("exp")} <span className="num">{F.day(g.expiry)}</span>
              {g.substitute && <> · <Pill tone="info" icon="repeat">{P("substitute")}</Pill> {g.reason}</>} · {F.name(g.by)} {F.time(g.at)}
            </li>
          ))}
        </ul>
      )}
      {l.declined && <Callout tone="warn" icon="circle-slash">{P("declined_by", { name: F.name(l.declined.by), reason: l.declined.reason })}</Callout>}

      {open && pick && (
        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(180px, 1fr) 120px", gap: 10, alignItems: "end" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", paddingBottom: 8 }}>
            <input type="checkbox" checked={pick.on} onChange={(e) => set({ on: e.target.checked })} data-testid="line-on" /> {P("give")}
          </label>
          <SelectField label={P("medicine_given")} value={pick.medicineKey} onChange={(e) => set({ medicineKey: e.target.value, ...(e.target.value !== l.prescribed.key ? { on: true, qty: String(l.remaining) } : {}) })} data-testid="line-medicine">
            <option value={l.prescribed.key}>{l.prescribed.brand} {l.prescribed.strength} · {P("as_prescribed")} · {P("available_n", { n: avail })}</option>
            {l.substitutes.map((x) => (
              <option key={x.medicine.key} value={x.medicine.key} disabled={x.allergy || x.available === 0}>
                {x.medicine.brand} {x.medicine.strength} · {P("substitute")} · {x.allergy ? P("allergic") : P("available_n", { n: x.available })}
              </option>
            ))}
          </SelectField>
          <TextField label={P("qty")} inputMode="numeric" value={pick.qty} onChange={(e) => set({ qty: e.target.value })} data-testid="line-give-qty" />
          {sub && (
            <div style={{ gridColumn: "1 / -1" }}>
              <TextField label={P("sub_reason")} hint={P("sub_reason_hint")} value={pick.reason} onChange={(e) => set({ reason: e.target.value })} data-testid="line-reason" />
            </div>
          )}
        </div>
      )}
      {open && pick?.medicineKey === l.prescribed.key && (
        <div className="t-small" data-testid="fefo">
          {l.proposal.allocations.length > 0
            ? <>{P("fefo_from")}: {l.proposal.allocations.map((a) => <span key={a.batch.id} className="num" style={{ marginRight: 8 }}>{a.batch.batchNo} ({P("exp")} {F.day(a.batch.expiry)}) × {F.n(a.qty)}</span>)}</>
            : null}
          {l.proposal.shortfall > 0 && <Callout tone="warn" icon="package-x">{P("shortfall", { n: l.proposal.shortfall })}</Callout>}
        </div>
      )}

      <details>
        <summary className="t-small">{P("batches_n", { n: l.batches.length })}</summary>
        <table className="t-small" style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
          <tbody>
            {l.batches.map((b) => (
              <tr key={b.id} data-batch={b.batchNo} data-state={b.state}>
                <td className="num">{b.batchNo}</td><td className="num">{P("exp")} {F.day(b.expiry)}</td><td>{P(`loc_${b.location}`)}</td>
                <td className="num">{F.n(b.qtyOnHand)}</td><td className="num">{F.tk(b.mrpPaisa)}</td><td><BatchState b={b} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        {l.label && (() => {
          // the label names what goes in the bag: the substitute being chosen, else what was last given, else the prescribed
          const m = sub?.medicine ?? (open ? null : l.given[l.given.length - 1]?.medicine) ?? l.prescribed;
          return <DoseLabel patient={patient} name={`${m.brand} ${m.strength}`} label={l.label.bn} />;
        })()}
        <span style={{ marginLeft: "auto" }} />
        {onPrint && <Button size="sm" icon="printer" onClick={onPrint} disabled={!s.online} data-testid="print-label">{P("print_label")}</Button>}
        {open && !l.declined && <Button size="sm" icon="circle-slash" onClick={onDecline} data-testid="decline">{P("decline")}</Button>}
      </div>
    </Card>
  );
}

/** The 50 × 30 mm label as it will print: medicine, the Bangla dose, the patient. */
function DoseLabel({ patient, name, label }: { patient: string; name: string; label: string }) {
  const P = useP();
  return (
    <figure style={{ margin: 0 }} data-testid="dose-label">
      <div style={{ width: 236, minHeight: 142, border: "1px dashed var(--border-strong)", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 4, background: "var(--surface-card)" }}>
        <b>{name}</b>
        <span style={{ fontSize: 15 }}>{label}</span>
        <span className="t-small t-secondary" style={{ marginTop: "auto" }}>{patient}</span>
      </div>
      <figcaption className="t-small t-muted">{P("label_caption")}</figcaption>
    </figure>
  );
}

function DeclineForm({ v, l, onDone }: { v: DispenseView; l: DispenseLine; onDone: (x: DispenseView) => void }) {
  const P = useP(); const E = useErr(); const toast = useToast(); const s = useSession();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [key] = useState(() => crypto.randomUUID());
  const ok = reason.trim().length >= 10;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span><b>{l.prescribed.brand} {l.prescribed.strength}</b> · {P("remaining_n", { n: l.remaining })}</span>
      <TextArea label={P("decline_reason")} hint={P("reason_hint")} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="decline-reason" />
      <Button variant="primary" icon="circle-slash" disabled={!ok || busy || !s.online} data-testid="decline-confirm"
        onClick={async () => { setBusy(true); try { onDone(await pharm.decline(v.encounter.id, { compositionId: v.composition.id, requestId: l.requestId, reason: reason.trim() }, key)); } catch (e) { toast(E(e), "triangle-alert"); } finally { setBusy(false); } }}>
        {P("decline_confirm")}
      </Button>
    </div>
  );
}

/** The visit's pharmacy bill: issue it, then take the money on the payment screen (the pharmacist's shift). */
function BillCard({ v, billView, onChanged }: { v: DispenseView; billView: InvoiceView | null; onChanged: () => Promise<void> }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [key, setKey] = useState(() => crypto.randomUUID()); const [busy, setBusy] = useState(false);
  if (!v.bill) return <Card style={{ padding: 12 }}><span className="t-small t-muted">{P("bill_none")}</span></Card>;
  const inv = billView?.invoice;
  return (
    <Card data-testid="pharmacy-bill" data-status={v.bill.status} style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, flexWrap: "wrap" }}>
      <b>{P("pharmacy_bill")}</b>
      <span className="num">{v.bill.number ?? P("draft")}</span>
      <span className="num" data-testid="bill-total">{F.tk(v.bill.totalPaisa)}</span>
      {v.bill.paidPaisa > 0 && <span className="t-small">{P("paid")}: <span className="num">{F.tk(v.bill.paidPaisa)}</span></span>}
      <Pill tone={v.bill.status === "balanced" ? "ok" : v.bill.status === "draft" ? "draft" : "warn"}>{P(`bs_${v.bill.status}`)}</Pill>
      <span style={{ marginLeft: "auto" }} />
      {v.bill.status === "draft" && inv && (
        <Button icon="file-check" data-testid="issue-bill" disabled={!s.online || busy}
          onClick={async () => { setBusy(true); try { await bill.issue(v.bill!.id, inv.rev, key); setKey(crypto.randomUUID()); await onChanged(); } catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setKey(crypto.randomUUID()); } finally { setBusy(false); } }}>
          {P("issue_bill")}
        </Button>
      )}
      {(v.bill.status === "issued" || v.bill.status === "partially-paid") && (
        <Button variant="primary" icon="wallet" data-testid="take-payment" onClick={() => router.push(`/m/ph/pay?inv=${encodeURIComponent(v.bill!.id)}`)}>{P("take_payment")}</Button>
      )}
      {v.bill.status === "balanced" && <Button icon="receipt" onClick={() => router.push(`/m/ph/receipt?inv=${encodeURIComponent(v.bill!.id)}`)}>{P("receipt")}</Button>}
    </Card>
  );
}
