"use client";
/* AI assistant panel (rule 2): always labelled "draft — not a diagnosis". The FakeAi adapter drafts only from the
   patient's own record; text the doctor inserts marks its section `ai-draft`, which blocks signing until the "I reviewed"
   tick. The scribe's "Patient agreed to recording" tick is shown but disabled — no recording until the lawyer's consent
   wording exists (Kamrul 02/10/2026); no audio is ever recorded. */
import { useState } from "react";
import type { AiDraftResponse } from "@setu/contracts";
import { Button, Card, Pill, useToast } from "@setu/ui";
import { ApiFailure, cons } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useC } from "./common";

export type AiInsert = { at: "history"; text: string } | { at: "exam"; field: "general" | "abdomen"; text: string };

export function AiPanel({ compositionId, editable, onInsert }: { compositionId: string; editable: boolean; onInsert: (i: AiInsert) => void }) {
  const s = useSession(); const C = useC(); const toast = useToast();
  const [busy, setBusy] = useState<"previsit" | "note" | null>(null);
  const [out, setOut] = useState<AiDraftResponse | null>(null);
  const [inserted, setInserted] = useState<string[]>([]);
  const run = async (kind: "previsit" | "note") => {
    setBusy(kind);
    try { setOut(await cons.aiDraft(compositionId, kind)); setInserted([]); }
    catch (e) { toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : C("ai_offline"), "triangle-alert"); }
    finally { setBusy(null); }
  };
  const proposals: { id: string; title: string; text: string; ins: AiInsert }[] = [];
  if (out?.proposals.history) proposals.push({ id: "history", title: C("sec_history"), text: out.proposals.history, ins: { at: "history", text: out.proposals.history } });
  for (const f of ["general", "abdomen"] as const) {
    const t = out?.proposals.exam?.[f];
    if (t) proposals.push({ id: `exam-${f}`, title: `${C("sec_exam")} · ${C(`exam_${f}`)}`, text: t, ins: { at: "exam", field: f, text: t } });
  }
  const can = editable && s.online && !busy;
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }} data-testid="ai-panel">
      <b className="t-h3">{C("ai_title")}</b>
      <span className="callout callout-warn" style={{ padding: "8px 10px" }} data-testid="ai-label">{C("ai_label")}</span>
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button size="sm" icon="sparkles" disabled={!can} onClick={() => void run("previsit")}>{busy === "previsit" ? C("ai_drafting") : C("ai_previsit")}</Button>
        <Button size="sm" icon="sparkles" disabled={!can} onClick={() => void run("note")}>{busy === "note" ? C("ai_drafting") : C("ai_note")}</Button>
      </span>
      {!s.online && <span className="t-small t-muted">{C("ai_offline")}</span>}
      {out && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="ai-output">
          {out.summary.map((l, i) => (
            <span key={i} className="t-small"><Pill tone="draft" icon="sparkles">AI</Pill> {s.L(l.textBn, l.textEn)} <span className="t-muted">· {C("ai_source", { s: l.source })}</span></span>
          ))}
          {out.summary.length === 0 && proposals.length === 0 && <span className="t-small t-muted">{C("ai_nothing")}</span>}
          {proposals.map((p) => (
            <div key={p.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, background: "var(--surface-sunken)" }} data-ai-proposal={p.id}>
              <b className="t-small">{p.title}</b>
              <span className="t-small" style={{ whiteSpace: "pre-wrap" }}>{p.text}</span>
              {inserted.includes(p.id) ? <span className="t-small t-muted">{C("ai_inserted")}</span> : (
                <Button size="sm" icon="corner-down-left" disabled={!editable} onClick={() => { onInsert(p.ins); setInserted((x) => [...x, p.id]); }}>{C("ai_insert")}</Button>
              )}
            </div>
          ))}
        </div>
      )}
      <label className="t-small" style={{ display: "flex", gap: 6, alignItems: "flex-start", opacity: 0.75 }} data-testid="scribe-consent">
        <input type="checkbox" disabled checked={false} readOnly aria-describedby="scribe-na" />
        <span style={{ display: "flex", flexDirection: "column" }}>
          <span>{C("scribe_consent")}</span>
          <span id="scribe-na" className="t-muted">{C("scribe_na")}</span>
        </span>
      </label>
    </Card>
  );
}
