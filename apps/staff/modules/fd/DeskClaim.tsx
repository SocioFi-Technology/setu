"use client";
/* "Link Setu app" (ADR 0024) — the reception confirms a patient-app claim in person: the patient shows the desk code
   in their app (that proves the app is theirs), the receptionist checks the NID or birth registration, picks this
   facility's record on the app's phone and links it — or says it could not be verified. The server decides; only
   records on that phone are offered, never a search. */
import { useState } from "react";
import type { DeskClaimView } from "@setu/contracts";
import { format } from "@setu/domain";
import { Button, Callout, Dialog, Icon, TextField, useToast } from "@setu/ui";
import { ApiFailure, fd } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useT } from "./common";

export function DeskClaimDialog({ onClose }: { onClose: () => void }) {
  const s = useSession(); const T = useT(); const toast = useToast();
  const [code, setCode] = useState("");
  const [view, setView] = useState<DeskClaimView | null>(null);
  const [pick, setPick] = useState("");
  const [doc, setDoc] = useState<"nid" | "birth-reg" | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bn = s.numerals === "bn";
  const msg = (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("desk_error"));
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(false); } };
  const find = () => run(async () => { setView(await fd.deskLookup(code)); setPick(""); setDoc(""); });
  const confirm = () => run(async () => {
    const r = await fd.deskConfirm({ code, patientId: pick, document: doc as "nid" | "birth-reg" }, crypto.randomUUID());
    toast(T("desk_linked", { no: r.facilityNo ?? "" }), "check"); onClose();
  });
  const refuse = () => run(async () => { await fd.deskRefuse(code, crypto.randomUUID()); toast(T("desk_refused_done"), "x"); onClose(); });
  const name = (r: DeskClaimView["records"][number]) => (s.lang === "bn" ? r.nameBn : r.nameEn ?? r.nameBn);

  return (
    <Dialog open onClose={onClose} label={T("desk_title")} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="desk-claim">
        <b className="t-h3">{T("desk_title")}</b>
        <span className="t-small t-muted">{T("desk_intro")}</span>
        {!view ? <>
          <TextField label={T("desk_code")} value={code} autoFocus autoComplete="off" spellCheck={false} maxLength={12} data-testid="desk-code"
            onChange={(e) => setCode(format.toEn(e.target.value).toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter" && code.trim().length >= 6) void find(); }} />
          {error && <Callout tone="bad" icon="circle-alert" role="alert">{error}</Callout>}
          <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button onClick={onClose}>{T("desk_cancel")}</Button>
            <Button variant="primary" icon="search" disabled={busy || code.trim().length < 6} onClick={() => void find()} data-testid="desk-find">{T("desk_find")}</Button>
          </span>
        </> : <>
          <span className="t-small">{T("desk_phone", { phone: view.phoneMasked, t: format.dateTime(view.codeUntil, bn) })}</span>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <legend className="t-small" style={{ fontWeight: 600, marginBottom: 4 }}>{T("desk_pick")}</legend>
            {view.records.length === 0 && <Callout tone="warn" icon="user-x">{T("desk_no_records")}</Callout>}
            {view.records.map((r) => (
              <label key={r.patientId} className="card" style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", cursor: "pointer", minHeight: 44 }} data-record={r.facilityNo}>
                <input type="radio" name="desk-record" checked={pick === r.patientId} onChange={() => setPick(r.patientId)} />
                <span style={{ flex: 1 }}><b>{name(r)}</b> · <span className="num">{r.facilityNo}</span>
                  <span className="t-small t-muted" style={{ display: "block" }}>{[r.ageYears !== null ? T("desk_age", { n: r.ageYears }) : null, T(`desk_sex_${r.sex}`), r.lastVisitAt ? T("desk_last", { t: format.date(r.lastVisitAt, bn) }) : null].filter(Boolean).join(" · ")}</span></span>
              </label>
            ))}
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <legend className="t-small" style={{ fontWeight: 600, marginBottom: 4 }}>{T("desk_doc")}</legend>
            {(["nid", "birth-reg"] as const).map((d) => (
              <label key={d} style={{ display: "inline-flex", gap: 6, alignItems: "center", minHeight: 44 }}>
                <input type="radio" name="desk-doc" checked={doc === d} onChange={() => setDoc(d)} data-doc={d} />{T(`desk_doc_${d}`)}
              </label>
            ))}
          </fieldset>
          <span className="t-small t-muted"><Icon name="shield-check" size={14} /> {T("desk_note")}</span>
          {error && <Callout tone="bad" icon="circle-alert" role="alert">{error}</Callout>}
          <span style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button variant="ghost" icon="user-x" disabled={busy} onClick={() => void refuse()} data-testid="desk-refuse">{T("desk_refuse")}</Button>
            <Button onClick={onClose}>{T("desk_cancel")}</Button>
            <Button variant="primary" icon="link" disabled={busy || !pick || !doc} onClick={() => void confirm()} data-testid="desk-confirm">{T("desk_confirm")}</Button>
          </span>
        </>}
      </div>
    </Dialog>
  );
}
