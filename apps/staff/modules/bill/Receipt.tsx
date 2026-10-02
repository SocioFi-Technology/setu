"use client";
/* bill/receipt — walkthrough A7. Ported from docs/prototype/Setu Billing.dc.html (screen "Receipt").
   ?rc= one receipt; ?inv= the bill's receipts. The PDF is made by the server (A5 Mushak-6.3 or 80 mm, Bangla + English
   / Bangla / English, QR to the public verify page). The first print is the original; every later print needs a
   reason and comes out as "অনুলিপি · DUPLICATE #n" — both are logged and listed under "Print audit". */
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReceiptList, ReceiptView } from "@setu/contracts";
import { Button, Callout, Card, PageState, Pill, Segmented, useToast } from "@setu/ui";
import { bill as api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useB, useErr, useMoney } from "./common";

const REASONS = ["lost", "jam", "corp", "ins"] as const;

export function BillReceipt() {
  const sp = useSearchParams();
  const rc = sp.get("rc"), inv = sp.get("inv");
  const B = useB();
  if (rc) return <ReceiptScreen id={rc} />;
  if (inv) return <ReceiptsOfBill invoiceId={inv} />;
  return <PageState icon="printer" title={B("rc_title")} body={B("rc_none")} />;
}

function ReceiptsOfBill({ invoiceId }: { invoiceId: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [list, setList] = useState<ReceiptList | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  useEffect(() => { api.receipts(invoiceId).then(setList).catch(() => setList({ items: [] })); }, [invoiceId]);
  if (!list) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  return (
    <div data-screen="bill/receipt" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{B("receipts")}</h1>
      {list.items.length === 0 && <PageState icon="printer" title={B("rc_none")} />}
      {list.items.map((r) => (
        <button key={r.id} type="button" className="card" style={{ display: "flex", gap: 12, padding: 12, textAlign: "left", cursor: "pointer" }} onClick={() => router.push(`/m/bill/receipt?rc=${encodeURIComponent(r.id)}`)}>
          <b className="num">{r.number}</b><span className="num">{M.dateTime(r.createdAt)}</span><span>{B("paid")}: <span className="num">{M.tk(r.paidPaisa)}</span></span>
          {r.duePaisa > 0 && <span>{B("due")}: <span className="num">{M.tk(r.duePaisa)}</span></span>}
        </button>
      ))}
      <span style={{ display: "flex", gap: 8 }}>
        <Button icon="receipt" disabled={!s.online} onClick={async () => { try { const r = await api.makeReceipt(invoiceId, key); router.push(`/m/bill/receipt?rc=${encodeURIComponent(r.receipt.id)}`); } catch (e) { toast(E(e), "triangle-alert"); } }}>{B("rc_new")}</Button>
        <Button icon="arrow-left" onClick={() => router.push(`/m/bill/opd?inv=${encodeURIComponent(invoiceId)}`)}>{B("bill_title")}</Button>
      </span>
    </div>
  );
}

function ReceiptScreen({ id }: { id: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [v, setV] = useState<ReceiptView | null>(null); const [failed, setFailed] = useState(false);
  const [lang, setLang] = useState<"both" | "bn" | "en">("both");
  const [paper, setPaper] = useState<"a5" | "thermal">("a5");
  const [reprint, setReprint] = useState(false); const [reason, setReason] = useState<(typeof REASONS)[number] | "">("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [shown, setShown] = useState<string | null>(null);

  const load = useCallback(async () => { try { setV(await api.receipt(id)); } catch { setFailed(true); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const print = async () => {
    if (!v || busy) return;
    const copy = v.prints.length;
    if (copy > 0 && !reason) return;
    setBusy(true);
    try {
      const r = await api.print(id, { format: paper, lang, ...(copy > 0 ? { reason: reason as (typeof REASONS)[number] } : {}) }, key);
      setV(r.view); setShown(r.print.pdfUrl); setReprint(false); setReason(""); setKey(crypto.randomUUID());
    } catch (e) { toast(E(e), "triangle-alert"); } finally { setBusy(false); }
  };

  if (failed) return <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const r = v.receipt; const snap = r.snapshot;
  const printed = v.prints.length > 0;
  return (
    <div data-screen="bill/receipt" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{B("rc_title")}</h1>
        <b className="num" data-testid="receipt-number">{r.number}</b>
        <span className="num t-muted">{M.dateTime(r.createdAt)}</span>
        {printed && <Pill tone="neu" icon="printer">{s.n(v.prints.length)}</Pill>}
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push(`/m/bill/opd?inv=${encodeURIComponent(r.invoiceId)}`)}>{B("bill_title")}</Button>
      </div>

      <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 16 }} data-testid="receipt-summary">
        <b>{s.lang === "bn" ? snap.seller.nameBn ?? snap.seller.nameEn : snap.seller.nameEn}</b>
        <span className="t-small">{B("r_bill_no")} <span className="num">{snap.invoice.number}</span> · {M.name(snap.patient)} · <span className="num">{snap.patient.facilityNo}</span></span>
        {snap.lines.map((l, n) => <span key={n} style={{ display: "flex", justifyContent: "space-between" }}><span>{s.lang === "bn" ? l.nameBn : l.nameEn}{l.qty > 1 ? ` ×${s.n(l.qty)}` : ""}</span><span className="num">{M.tk(l.grossPaisa)}</span></span>)}
        <span style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-subtle)", paddingTop: 6 }}><b>{B("total")}</b><b className="num">{M.tk(r.totalPaisa)}</b></span>
        <span style={{ display: "flex", justifyContent: "space-between" }}><span>{B("paid")}</span><span className="num" data-testid="receipt-paid">{M.tk(r.paidPaisa)}</span></span>
        <span style={{ display: "flex", justifyContent: "space-between" }}><span>{B("due")}</span><span className="num">{M.tk(r.duePaisa)}</span></span>
        <span className="t-small">{B("in_words")}: {M.words(r.paidPaisa)}</span>
        <span className="t-small" data-testid="receipt-paid-by"><b>{B("paid_by")}:</b> {snap.paidBy.paid.map((p) => `${B(`m_${p.method}`)} ${M.tk(p.amountPaisa)}${p.trxId ? ` (TrxID ${p.trxId})` : ""}`).join(" + ") || "—"}
          {snap.paidBy.pending.length > 0 && ` · ${snap.paidBy.pending.map((p) => `${B(`m_${p.method}`)} ${M.tk(p.amountPaisa)} ${B("pending_word")}`).join(" · ")}`}</span>
        <span className="t-small t-muted">{B("rc_verify_url")}: <a href={r.verifyUrl} target="_blank" rel="noreferrer" data-testid="verify-url">{r.verifyUrl}</a></span>
      </Card>

      <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        <span style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <span className="t-small">{B("rc_lang")}</span>
          <Segmented label={B("rc_lang")} value={lang} onChange={setLang} options={[{ value: "both", label: B("rc_lang_both") }, { value: "bn", label: B("rc_lang_bn") }, { value: "en", label: B("rc_lang_en") }]} />
          <span className="t-small">{B("rc_format")}</span>
          <Segmented label={B("rc_format")} value={paper} onChange={setPaper} options={[{ value: "a5", label: B("rc_format_a5") }, { value: "thermal", label: B("rc_format_thermal") }]} />
        </span>
        {!printed ? (
          <Button variant="primary" icon="printer" data-testid="print" disabled={busy || !s.online} onClick={() => void print()}>{busy ? B("waiting_server") : B("rc_print")}</Button>
        ) : !reprint ? (
          <Button icon="copy" data-testid="reprint" disabled={!s.online} onClick={() => setReprint(true)}>{B("rc_reprint")}</Button>
        ) : (
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }} data-testid="reprint-panel">
            <b>{B("rc_reprint_title")}</b>
            <span className="t-small t-muted">{B("rc_reprint_hint")}</span>
            <label className="field t-small">{B("rc_reason")}
              <select name="reprint-reason" className="input" value={reason} onChange={(e) => { setReason(e.target.value as typeof reason); setKey(crypto.randomUUID()); }}>
                <option value="">{B("disc_choose")}</option>
                {REASONS.map((x) => <option key={x} value={x}>{B(`rr_${x}`)}</option>)}
              </select>
            </label>
            <span style={{ display: "flex", gap: 8 }}>
              <Button variant="primary" icon="printer" data-testid="print-duplicate" disabled={busy || !reason} onClick={() => void print()}>{B("rc_print_duplicate")}</Button>
              <Button onClick={() => { setReprint(false); setReason(""); }}>{B("rc_cancel")}</Button>
            </span>
          </Card>
        )}
        {shown && (
          <>
            <a href={`/api${shown}`} target="_blank" rel="noreferrer" data-testid="open-pdf">{B("rc_open_pdf")}</a>
            <iframe title={r.number} src={`/api${shown}`} style={{ width: "100%", height: 640, border: "1px solid var(--border-subtle)" }} />
          </>
        )}
      </Card>

      {printed && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 4, padding: 16 }} data-testid="print-audit">
          <b>{B("rc_audit")}</b>
          {v.prints.map((p) => (
            <span key={p.id} className="t-small" data-copy={p.copy}>
              {p.copy === 0 ? B("rc_audit_original", { name: M.name(p.printedBy), at: M.dateTime(p.printedAt) }) : B("rc_audit_dup", { n: p.copy, reason: B(`rr_${p.reason}`), name: M.name(p.printedBy), at: M.dateTime(p.printedAt) })}
              {" · "}<a href={`/api${p.pdfUrl}`} target="_blank" rel="noreferrer">PDF</a>
            </span>
          ))}
        </Card>
      )}
    </div>
  );
}
