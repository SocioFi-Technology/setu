"use client";
/* Print a prescription (rx = a consultation note version), a lab report version (lr) or a discharge summary (ds, A4) — walkthrough A13, ADR 0007.
   The preview is rendered by the server without a QR and logs no print; a draft shows the DRAFT watermark and the
   message "Drafts cannot be printed — sign first" with Print disabled (issue #19). The first print is the original;
   later ones need a reason and come out "DUPLICATE #n". Nothing says "printed" until the server answers. */
import { useCallback, useEffect, useState } from "react";
import type { DocPrintView } from "@setu/contracts";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Card, Segmented, useToast } from "@setu/ui";
import { ApiFailure, docs, type DocKindT } from "../lib/api";
import { useSession } from "../lib/session";

const REASONS = ["lost", "jam", "copy"] as const;

export function PrintPanel({ kind, id, compact = false }: { kind: DocKindT; id: string; compact?: boolean }) {
  const s = useSession(); const toast = useToast();
  const P = (key: string, vars: Record<string, string | number> = {}) => fill(s.t("printApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
  const [v, setV] = useState<DocPrintView | null>(null);
  const [failed, setFailed] = useState(false);
  // the discharge summary prints A4 only (ADR 0018)
  const [paper, setPaper] = useState<"a5" | "a4">(kind === "ds" ? "a4" : "a5");
  const [lang, setLang] = useState<"both" | "bn" | "en">("both");
  const [reason, setReason] = useState<(typeof REASONS)[number] | "">("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => { try { setV(await docs.view(kind, id)); setFailed(false); } catch { setFailed(true); } }, [kind, id]);
  useEffect(() => { void load(); }, [load]);

  const print = async () => {
    if (!v || busy) return;
    const copy = v.prints.length;
    if (copy > 0 && !reason) return;
    setBusy(true);
    try {
      const r = await docs.print(kind, id, { format: paper, lang, ...(copy > 0 ? { reason: reason as (typeof REASONS)[number] } : {}) }, key);
      setV(r); setShown(r.print.pdfUrl); setReason(""); setKey(crypto.randomUUID());
      toast(P("ui_printed", { copy: r.print.copy === 0 ? P("ui_copy0") : P("ui_copyN", { n: r.print.copy }) }), "printer");
    } catch (e) { toast(e instanceof ApiFailure ? (s.lang === "bn" ? e.body.message_bn : e.body.message_en) : P("ui_offline"), "triangle-alert"); await load(); }
    finally { setBusy(false); }
  };

  if (failed) return <Callout tone="warn" icon="triangle-alert">{s.L("প্রিন্টের তথ্য আনা যায়নি", "Could not load the print state")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">…</div>;
  const blocked = v.blockers[0];
  const printed = v.prints.length > 0;
  const blockMsg = blocked === "draft_not_printable" ? P("draft_note") : blocked === "superseded_not_printable" ? P("superseded_print") : blocked ? P("withdrawn_print") : null;
  const when = (iso: string) => format.dateTime(iso, s.numerals === "bn");
  const who = (p: { nameBn: string; nameEn: string }) => (s.lang === "bn" ? p.nameBn : p.nameEn);

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: compact ? 12 : 16 }} data-testid={`print-panel-${kind}`} data-blocked={blocked ?? ""}>
      <b>{P("ui_title")}</b>
      {blockMsg && <Callout tone={blocked === "draft_not_printable" ? "warn" : "bad"} icon="ban" data-testid="print-blocked">{blockMsg}</Callout>}
      <span style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        {kind !== "ds" && <><span className="t-small">{P("ui_paper")}</span>
        <Segmented label={P("ui_paper")} value={paper} onChange={setPaper} options={[{ value: "a5", label: "A5" }, { value: "a4", label: "A4" }]} /></>}
        <span className="t-small">{P("ui_lang")}</span>
        <Segmented label={P("ui_lang")} value={lang} onChange={setLang} options={[{ value: "both", label: P("lang_both") }, { value: "bn", label: P("lang_bn") }, { value: "en", label: P("lang_en") }]} />
      </span>
      {!blocked && (printed ? (
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field t-small" style={{ flex: "1 1 200px" }}>{P("ui_reason")}
            <select name="doc-reprint-reason" className="input" value={reason} onChange={(e) => { setReason(e.target.value as typeof reason); setKey(crypto.randomUUID()); }}>
              <option value="">{P("ui_choose")}</option>
              {REASONS.map((x) => <option key={x} value={x}>{P(`rr_${x}`)}</option>)}
            </select>
          </label>
          <Button icon="copy" data-testid="doc-reprint" disabled={busy || !reason || !s.online} onClick={() => void print()}>{busy ? P("ui_printing") : P("ui_reprint")}</Button>
        </span>
      ) : (
        <Button variant="primary" icon="printer" data-testid="doc-print" disabled={busy || !s.online} onClick={() => void print()}>{busy ? P("ui_printing") : !s.online ? P("ui_offline") : P("ui_print")}</Button>
      ))}
      {blocked === "draft_not_printable" && <Button icon="printer" data-testid="doc-print" disabled>{P("ui_print")}</Button>}
      {/* a phone's browser does not show a PDF inside a page (hands-on test A12–A13): the compact panel opens it */}
      {shown ? (
        <>
          <a href={docs.pdfSrc(shown)} target="_blank" rel="noreferrer" data-testid="doc-open-pdf" className={compact ? "btn btn-primary" : undefined} style={compact ? { justifyContent: "center" } : undefined}>{P("ui_open")}</a>
          {!compact && <iframe title={P("ui_title")} src={docs.pdfSrc(shown)} style={{ width: "100%", height: 640, border: "1px solid var(--border-subtle)" }} />}
        </>
      ) : compact ? (
        <a href={docs.previewSrc(kind, id, paper, lang)} target="_blank" rel="noreferrer" data-testid="doc-preview" className="btn" style={{ justifyContent: "center" }}>{P("ui_open_preview")}</a>
      ) : (
        <>
          <span className="t-small t-muted">{P("ui_preview")}</span>
          <iframe title={P("ui_preview")} data-testid="doc-preview" src={docs.previewSrc(kind, id, paper, lang)} style={{ width: "100%", height: 640, border: "1px solid var(--border-subtle)" }} />
        </>
      )}
      {v.verifyUrl && <span className="t-small t-muted">{P("ui_verify")}: <a href={v.verifyUrl} target="_blank" rel="noreferrer" data-testid="doc-verify-url">{v.verifyUrl}</a></span>}
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }} data-testid="doc-print-log">
        <span className="t-small"><b>{P("ui_log")}</b></span>
        {!printed && <span className="t-small t-muted">{P("ui_none")}</span>}
        {v.prints.map((p) => (
          <span key={p.id} className="t-small" data-copy={p.copy}>
            {p.copy === 0 ? P("ui_copy0") : `${P("ui_copyN", { n: p.copy })} — ${P(`rr_${p.reason}`)}`} · {who(p.printedBy)} · <span className="num">{when(p.printedAt)}</span> · {p.format.toUpperCase()}
            {/* clinical review M5: no stored copy of a replaced or withdrawn version (it would print as a clean original) */}
            {!blocked && <>{" · "}<a href={docs.pdfSrc(p.pdfUrl)} target="_blank" rel="noreferrer">PDF</a></>}
          </span>
        ))}
      </span>
    </Card>
  );
}
