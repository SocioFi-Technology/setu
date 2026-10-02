"use client";
/* Sign sheet (walkthrough A5; CLAUDE.md rule 1). The draft is first saved to the server, then the PIN goes with the sign
   request, which re-runs the blockers on the server's data. Until the server answers the sheet says "Waiting for
   server — still a draft"; the note becomes Signed only on the signed screen, which reads it from the server. One
   Idempotency-Key per opening of the sheet: a wrong PIN then the right one is the same request (the PIN is never part
   of the stored hash). Never offered offline (decision 25). */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CompositionView, ConsultationView } from "@setu/contracts";
import { aiSections, format, signBlockers, type SignBlocker } from "@setu/domain";
import { Button, Dialog } from "@setu/ui";
import { ApiFailure, cons } from "../../lib/api";
import { useSession } from "../../lib/session";
import { factsOf, rxLinesOf, useC, type Form, type Line } from "./common";
import { warningText } from "./Rx";

type Phase = { st: "saving" } | { st: "ready" } | { st: "waiting" } | { st: "save-failed" };

export function SignSheet({ view, draft, form, rev, ensureSaved, onClose, onSigned }: {
  view: ConsultationView; draft: CompositionView; form: Form; rev: () => number;
  ensureSaved: () => Promise<boolean>; onClose: () => void; onSigned: (v: ConsultationView) => void;
}) {
  const s = useSession(); const C = useC();
  const [phase, setPhase] = useState<Phase>({ st: "saving" });
  const [pin, setPin] = useState("");
  const [aiReviewed, setAiReviewed] = useState(false);
  const [uncodedChecked, setUncodedChecked] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [serverBlockers, setServerBlockers] = useState<SignBlocker[] | null>(null);
  const key = useRef(crypto.randomUUID());
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => { let live = true; ensureSaved().then((ok) => { if (live) setPhase(ok ? { st: "ready" } : { st: "save-failed" }); }); return () => { live = false; }; }, [ensureSaved]);
  useEffect(() => { if (phase.st === "ready") pinRef.current?.focus(); }, [phase.st]);

  const facts = useMemo(() => factsOf(view.allergies), [view.allergies]);
  const ai = aiSections(form.sources);
  const uncoded = facts.filter((a) => a.kind === "other" || a.key === null);
  const blockers = signBlockers({
    sections: form.sections, sources: form.sources, diagnoses: form.diagnoses, lines: rxLinesOf(form.lines), allergies: facts,
    aiReviewed, uncodedAllergiesChecked: uncodedChecked, isAmendment: Boolean(draft.amendsId), amendReason: draft.amendReason,
  });
  // The ticks are on this sheet; everything else must be fixed in the note first.
  const hard = blockers.filter((b) => b.code !== "ai_review_required" && b.code !== "uncoded_allergy_check");
  const shown = serverBlockers ?? hard;
  const canSign = s.online && phase.st === "ready" && blockers.length === 0 && /^\d{4}$/.test(format.toEn(pin));

  const submit = async () => {
    if (!canSign) return;
    setPhase({ st: "waiting" }); setMsg(null); setServerBlockers(null);
    try {
      const v = await cons.sign(draft.id, { rev: rev(), pin: format.toEn(pin), aiReviewed, uncodedAllergiesChecked: uncodedChecked }, key.current);
      onSigned(v);
    } catch (e) {
      setPin("");
      if (e instanceof ApiFailure) {
        const b = e.body as typeof e.body & { triesLeft?: number; lockedUntil?: string; blockers?: SignBlocker[] };
        if (e.body.code === "pin_wrong") setMsg(C("pin_wrong", { n: b.triesLeft ?? 0 }));
        else if (e.body.code === "pin_locked") setMsg(C("pin_locked", { t: b.lockedUntil ? format.time(b.lockedUntil, s.numerals === "bn") : "—" }));
        else if (e.body.code === "sign_blocked") { setServerBlockers(b.blockers ?? []); setMsg(s.L(e.body.message_bn, e.body.message_en)); }
        else setMsg(s.L(e.body.message_bn, e.body.message_en));
      } else setMsg(C("ss_network"));
      setPhase({ st: "ready" });
    }
  };

  const lineOf = (uid: string): Pick<Line, "medicine"> => {
    const l = form.lines.find((x) => x.uid === uid);
    if (l) return l;
    const m = draft.medications.find((x) => x.id === uid);
    return { medicine: { key: m?.medicineKey ?? "", brand: m?.brand ?? "", generic: m?.generic ?? "", strength: m?.strength ?? "", form: m?.form ?? "", ingredients: [], classes: [] } };
  };
  const text = (b: SignBlocker) => {
    switch (b.code) {
      case "rx": { const l = lineOf(b.warning.line); return `${l.medicine.brand}: ${warningText(b.warning, l, C, s.L)}`; }
      case "no_complaint": return C("b_no_complaint");
      case "no_diagnosis": return C("b_no_diagnosis");
      case "ai_review_required": return C("b_ai");
      case "uncoded_allergy_check": return C("b_uncoded");
      case "amend_reason": return C("b_amend_reason");
    }
  };
  const p = view.encounter.patient;
  const busy = phase.st === "saving" || phase.st === "waiting";

  return (
    <Dialog open onClose={() => { if (phase.st !== "waiting") onClose(); }} label={C("ss_title")} width={620}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="sign-sheet">
        <b className="t-h3">{draft.amendsId ? C("sign_amend") : C("ss_title")}</b>
        <span className="t-small t-muted num">{s.L(p.nameBn, p.nameEn ?? p.nameBn)} · {p.facilityNo} · {C("token", { t: view.encounter.token })}</span>

        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 4, padding: 10, background: "var(--surface-sunken)" }}>
          <b className="t-small">{C("ss_final")}</b>
          <span className="t-small">{C("ss_complaints")}: {form.sections.complaints.map((c) => c.text).join(", ") || "—"}</span>
          <span className="t-small">{C("ss_dx")}: {form.diagnoses.map((d) => `${d.code} ${s.L(d.labelBn, d.labelEn)}${d.verificationStatus === "provisional" ? ` (${C("dx_provisional")})` : ""}`).join(", ") || "—"}</span>
          <span className="t-small">{C("ss_rx")}: {form.lines.map((l) => `${l.medicine.form} ${l.medicine.brand} ${l.medicine.strength} ${s.n(l.dose)}`).join(", ") || "—"}</span>
          <span className="t-small">{C("ss_orders")}: {form.orders.map((o) => s.L(o.nameBn, o.nameEn)).join(", ") || "—"}</span>
        </div>

        {shown.length > 0 && (
          <div className="callout callout-bad" role="alert" data-testid="sign-blockers" style={{ flexDirection: "column", gap: 4 }}>
            <b>{C("ss_blocked")}</b>
            {shown.map((b, i) => <span key={i} data-blocker={b.code === "rx" ? `rx-${b.warning.kind}` : b.code}>• {text(b)}</span>)}
          </div>
        )}
        {ai.length > 0 && (
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" name="ai-reviewed" checked={aiReviewed} disabled={busy} onChange={(e) => setAiReviewed(e.target.checked)} />
            <span>{C("ai_reviewed_tick")}</span>
          </label>
        )}
        {uncoded.length > 0 && form.lines.length > 0 && (
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" name="uncoded-checked" checked={uncodedChecked} disabled={busy} onChange={(e) => setUncodedChecked(e.target.checked)} />
            <span>{C("uncoded_tick", { list: uncoded.map((a) => s.L(a.labelBn, a.labelEn)).join(", ") })}</span>
          </label>
        )}

        <label className="field" style={{ maxWidth: 220 }}>
          <span>{C("pin")}</span>
          <input ref={pinRef} className="input num" name="sign-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin} disabled={busy || !s.online}
            onChange={(e) => setPin(e.target.value.replace(/[^0-9০-৯]/g, ""))} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }} />
        </label>
        <span className="t-small">{s.me ? s.L(s.me.nameBn, s.me.nameEn) : ""}</span>

        <span role="status" data-testid="sign-status" data-phase={phase.st} className="t-small" style={{ fontWeight: 600 }}>
          {phase.st === "saving" ? C("sync_saving") : phase.st === "waiting" ? C("ss_waiting") : phase.st === "save-failed" ? C("sync_failed") : !s.online ? C("sign_offline") : C("ss_still_draft")}
        </span>
        {msg && <span className="field-error" role="alert" data-testid="sign-error">{msg}</span>}

        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose} disabled={phase.st === "waiting"}>{C("ss_back")}</Button>
          <Button variant="primary" icon="pen-tool" disabled={!canSign} onClick={() => void submit()}>{!s.online ? C("sign_offline") : C("ss_sign")}</Button>
        </span>
      </div>
    </Dialog>
  );
}
