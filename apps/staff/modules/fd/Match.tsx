"use client";
/* fd/match — walkthrough A2, issue #4. Ported from docs/prototype/Setu Front Desk.dc.html (screen=match).
   One-click link only when nothing conflicts; otherwise "Send for review" or "Link anyway" with a ≥10-character reason
   and a confirm dialog listing every conflicting field. The server enforces the same rules. */
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MatchCandidate, MatchDecisionResponse, PatientMatches, PatientSummary } from "@setu/contracts";
import { LINK_REASON_MIN, MATCH_FIELDS, concernsOf, format, type FieldStatus, type MatchField } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { ApiFailure, fd } from "../../lib/api";
import { useSession } from "../../lib/session";
import { bannerOf, useLabels, useT } from "./common";
import { ReviewQueue, UnlinkDialog } from "./Review";

const TONE: Record<FieldStatus, Tone> = { same: "ok", similar: "info", different: "bad", missing: "neu" };

export function FrontDeskMatch() {
  const s = useSession(); const T = useT(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const id = useSearchParams().get("id");
  const [data, setData] = useState<PatientMatches | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [decision, setDecision] = useState<{ text: string; r: MatchDecisionResponse } | null>(null);
  const [forcing, setForcing] = useState<MatchCandidate | null>(null);
  const [reason, setReason] = useState("");
  const [unsure, setUnsure] = useState("");
  const [busy, setBusy] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoReason, setUndoReason] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setState("loading");
    try { setData(await fd.matches(id)); setState("ready"); } catch { setState("error"); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // The banner shows the record the visit will go on: after a link, that is the record linked to (clinical review).
  const bannerPatient = decision ? decision.r.continueWith : data?.subject;
  useEffect(() => { if (bannerPatient) s.setPatient(bannerOf(bannerPatient, L)); }, [bannerPatient?.id, bannerPatient?.identityConfidence, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const name = (p: PatientSummary) => (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn);
  const fail = (e: unknown) => toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("error_generic"), "triangle-alert");

  const decide = async (d: "link" | "linkAnyway" | "review" | "different", c?: MatchCandidate, why?: string) => {
    if (!id || busy) return; setBusy(true);
    try {
      const r = await fd.decide(id, { decision: d, candidateId: c?.patient.id, reason: why });
      const n = r.conflicts.length;
      const text = d === "link" ? T("decided_link", { name: name(r.continueWith), no: r.continueWith.facilityNo })
        : d === "linkAnyway" ? T("decided_link_anyway", { n, name: name(r.continueWith), no: r.continueWith.facilityNo }) + (why ? ` · ${T("reason_label").replace(" *", "")}: "${why.trim()}"` : "")
        : d === "review" ? T("decided_review") : T("decided_different");
      setDecision({ text, r }); setForcing(null); setReason(""); setUnsure("");
      await load();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  /* Undo (open question 17): only the decider or an admin; a Link anyway needs a reason; the dialog lists the visits
     opened on the linked record since the link (they stay where they are). */
  const undo = async () => {
    if (!id || busy) return; setBusy(true);
    try { await fd.undo(id, undoReason.trim() || undefined); setDecision(null); setUndoOpen(false); setUndoReason(""); toast(T("decided_undo"), "undo-2"); await load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const openUndo = async () => { setUndoReason(""); await load(); setUndoOpen(true); };
  const visit = async (p: PatientSummary) => {
    setBusy(true);
    try {
      const r = await fd.createVisit(p.id);
      if (r.queued) { toast(T("queued_offline"), "cloud-off"); return; }
      router.push(`/m/fd/queue?sel=${r.data.encounter.id}`);
    } catch (e) {
      if (e instanceof ApiFailure && e.body.code === "visit_exists") router.push(`/m/fd/queue?sel=${(e.body.existing as { encounterId?: string }).encounterId ?? ""}`);
      else fail(e);
    } finally { setBusy(false); }
  };

  if (!id) return <ReviewQueue />;
  if (state === "loading" && !data) return <div aria-busy="true" className="t-muted">{T("match_loading")}</div>;
  if (state === "error" || !data) return <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>;

  const subj = data.subject;
  const cands = data.candidates;
  const value = (p: PatientSummary, f: MatchField): string => {
    switch (f) {
      case "nameBn": return p.nameBn;
      case "nameEn": return p.nameEn ?? "—";
      case "sex": return L.sex(p.sex);
      case "birth": return p.birthDate ? s.n(p.birthDate.split("-").reverse().join("/")) : p.approxAgeYears != null ? L.age(p) : "—";
      case "guardian": return p.guardian ? `${p.guardian.name} · ${L.rel(p.guardian.relationship)}` : "—";
      case "phone": return s.n(L.phone(p.phone));
      case "address": return [p.address.upazila, p.address.district].filter(Boolean).join(", ") || "—";
      case "id": return p.hasNid ? T("on_file") : "—";
    }
  };
  const linked = Boolean(subj.linkedToId);
  const laTitle = (c: MatchCandidate) => (c.comparison.conflicts.length ? T("la_title", { n: c.comparison.conflicts.length }) : T("la_title_weak"));
  const top = cands[0];

  return (
    <div data-screen="fd/match" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{T("match_title")}</h1>
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/fd/search")}>{T("back_to_search")}</Button>
      </div>

      {linked && data.linkedTo && !decision && (
        <div role="status" className="callout callout-warn" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }} data-testid="linked-note">
          <span style={{ flex: "1 1 300px" }}>{T("linked_note", { name: name(data.linkedTo), no: data.linkedTo.facilityNo })}</span>
          {s.me?.role === "admin" && <Button size="sm" variant="danger" icon="unlink" onClick={() => setUnlinkOpen(true)}>{T("unlink")}</Button>}
        </div>
      )}
      {data.linkedTo && (
        <UnlinkDialog open={unlinkOpen} subjectId={subj.id} onClose={() => setUnlinkOpen(false)} onDone={() => { setUnlinkOpen(false); setDecision(null); void load(); }}
          title={T("unlink_title", { name: name(subj), other: name(data.linkedTo) })} />
      )}

      {decision && (
        <div role="status" className="callout" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 300px" }} data-testid="decision">{decision.text}</span>
          <Button size="sm" icon="undo-2" disabled={busy} onClick={() => void openUndo()}>{T("undo")}</Button>
          <Button size="sm" variant="primary" icon="ticket" disabled={busy} onClick={() => void visit(decision.r.continueWith)}>{T("visit_for", { name: name(decision.r.continueWith) })}</Button>
        </div>
      )}

      {undoOpen && (() => {
        const ld = data.lastDecision;
        const ok = ld?.canUndo && (!ld.reasonRequired || undoReason.trim().length >= ld.reasonMin);
        return (
          <Dialog open onClose={() => setUndoOpen(false)} label={T("undo_title")} width={540}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="undo-dialog">
              <h2 className="t-h3" style={{ margin: 0 }}>{T("undo_title")}</h2>
              {!ld ? <span>{T("undo_nothing")}</span> : <>
                <span className="t-small t-muted">{T("undo_by", { name: ld.by ? s.L(ld.by.nameBn, ld.by.nameEn) : "—", at: format.dateTime(ld.at, s.numerals === "bn") })}</span>
                {!ld.canUndo && <Callout tone="warn" icon="lock">{T("undo_not_allowed")}</Callout>}
                {(ld.activity === "link" || ld.activity === "link-anyway") && (ld.visitsSince.length ? (
                  <Callout tone="warn" icon="triangle-alert">
                    {T("undo_visits", { n: ld.visitsSince.length })}
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }} data-testid="undo-visits">
                      {ld.visitsSince.map((v) => <li key={v.encounterId} className="num">{T("visit_line", { token: v.token, day: s.n(v.day.split("-").reverse().join("/")) })}</li>)}
                    </ul>
                  </Callout>
                ) : <span className="t-small t-muted">{T("undo_no_visits")}</span>)}
                {ld.canUndo && ld.reasonRequired && (
                  <TextArea label={T("undo_reason", { n: ld.reasonMin })} rows={3} value={undoReason} onChange={(e) => setUndoReason(e.target.value)} hint={T("reason_hint", { n: Math.min(undoReason.trim().length, ld.reasonMin) })} autoFocus />
                )}
              </>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <Button onClick={() => setUndoOpen(false)}>{T("cancel")}</Button>
                <Button variant="danger" icon="undo-2" disabled={busy || !ok} onClick={() => void undo()}>{T("undo_confirm")}</Button>
              </div>
            </div>
          </Dialog>
        );
      })()}

      {cands.length === 0 ? (
        <PageState icon="shield-check" title={T("match_none_title")} body={T("match_none_body")}
          actions={<Button variant="primary" icon="ticket" disabled={busy} onClick={() => void visit(subj)}>{T("visit_for", { name: name(subj) })}</Button>} />
      ) : (
        <>
          <Callout icon="info">{T("match_note")}</Callout>
          <Card style={{ padding: 0, overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 150 + (cands.length + 1) * 200, width: "100%" }} aria-label={T("match_title")}>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>{T("field")}</th>
                  <th>{T("this_record")}<div className="t-small t-muted" style={{ fontWeight: 400 }}>{name(subj)} · <span className="num">{subj.facilityNo}</span></div></th>
                  {cands.map((c, i) => (
                    <th key={c.patient.id} data-candidate={c.patient.facilityNo}>
                      {T("candidate_n", { n: i + 1 })} · <span className="num">{T("score", { n: c.comparison.score })}</span>
                      <div className="t-small t-muted" style={{ fontWeight: 400 }}>{name(c.patient)} · <span className="num">{c.patient.facilityNo}</span></div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATCH_FIELDS.map((f) => (
                  <tr key={f}>
                    <td className="t-muted">{T(`f_${f}`)}</td>
                    <td>{value(subj, f)}</td>
                    {cands.map((c) => {
                      const st = c.comparison.fields[f] as FieldStatus;
                      return (
                        <td key={c.patient.id} data-field={f} data-status={st}>
                          <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <span>{value(c.patient, f)}</span>
                            <Pill tone={TONE[st]}>{T(`st_${st}`)}</Pill>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <td />
                  <td />
                  {cands.map((c) => (
                    <td key={c.patient.id} style={{ verticalAlign: "top" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                        {c.comparison.isGuardian || c.comparison.fields.sex === "different" ? (
                          <Pill tone="bad" icon="ban">{c.comparison.isGuardian ? T("is_guardian_note") : T("sex_conflict_note")}</Pill>
                        ) : c.canLink ? (
                          <>
                            <Button variant="primary" size="sm" icon="link" disabled={busy || linked} onClick={() => void decide("link", c)} style={{ whiteSpace: "nowrap" }}>{T("same_person_link")}</Button>
                            {c.comparison.strong && <span className="t-small t-muted">{T("strong_note")}</span>}
                          </>
                        ) : (
                          <>
                            <span className="t-small" style={{ color: c.comparison.conflicts.length ? "var(--danger-text)" : undefined }}>{c.comparison.conflicts.length ? T("conflicts_note", { n: c.comparison.conflicts.length }) : T("not_strong_note")}</span>
                            <Button size="sm" icon="send" disabled={busy || linked || Boolean(data.openReview)} onClick={() => void decide("review", c)} style={{ whiteSpace: "nowrap" }}>{T("send_for_review")}</Button>
                            {c.canLinkAnyway && <Button size="sm" variant="danger" icon="link-2" disabled={busy || linked} onClick={() => { setForcing(c); setReason(""); }} style={{ whiteSpace: "nowrap" }}>{T("link_anyway")}</Button>}
                          </>
                        )}
                      </div>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </Card>

          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Button icon="user-x" disabled={busy || linked} onClick={() => void decide("different")}>{T("different_person")}</Button>
            <span style={{ flex: "1 1 280px", minWidth: 0 }}><TextField label={T("not_sure_reason")} value={unsure} onChange={(e) => setUnsure(e.target.value)} /></span>
            <Button icon="send" disabled={busy || linked || !top || Boolean(data.openReview)} onClick={() => void decide("review", top, unsure)}>{T("not_sure_send")}</Button>
          </div>
        </>
      )}

      <Dialog open={forcing !== null} onClose={() => setForcing(null)} label={forcing ? laTitle(forcing) : ""} width={560}>
        {forcing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
            <h2 className="t-h3" style={{ margin: 0 }}>{laTitle(forcing)}</h2>
            <span className="t-small t-muted">{T("la_sub", { name: name(forcing.patient), no: forcing.patient.facilityNo })}</span>
            <table className="table" aria-label="conflicts">
              <thead><tr><th>{T("field")}</th><th>{T("this_record")}</th><th>{name(forcing.patient)}</th><th /></tr></thead>
              <tbody>{concernsOf(forcing.comparison as Parameters<typeof concernsOf>[0]).map((f) => { const st = forcing.comparison.fields[f] as FieldStatus; return <tr key={f} data-conflict={st === "different" ? f : undefined} data-concern={f}><td>{T(`f_${f}`)}</td><td>{value(subj, f)}</td><td>{value(forcing.patient, f)}</td><td><Pill tone={TONE[st]}>{T(`st_${st}`)}</Pill></td></tr>; })}</tbody>
            </table>
            <TextArea label={T("reason_label")} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={T("reason_placeholder")}
              hint={T("reason_hint", { n: Math.min(reason.trim().length, LINK_REASON_MIN) })} autoFocus />
            <Callout icon="info">{T("la_officer")}</Callout>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Button onClick={() => setForcing(null)}>{T("cancel")}</Button>
              <Button variant="danger" icon="link-2" disabled={busy || reason.trim().length < LINK_REASON_MIN} onClick={() => void decide("linkAnyway", forcing, reason)}>{T("confirm_link")}</Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
