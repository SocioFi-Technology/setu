"use client";
/* Duplicate-review queue (fd/match with no patient) and the admin Unlink dialog — decision 16, 02/10/2026:
   "Link anyway" stays immediate; an admin reviews overrides afterwards and can unlink or keep them. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReviewItem } from "@setu/contracts";
import { LINK_REASON_MIN } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, TextArea, useToast } from "@setu/ui";
import { ApiFailure, fd } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLabels, useT } from "./common";

export function UnlinkDialog({ open, subjectId, title, onClose, onDone }: { open: boolean; subjectId: string; title: string; onClose: () => void; onDone: () => void }) {
  const s = useSession(); const T = useT(); const toast = useToast();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setReason(""); }, [open]);
  const go = async () => {
    setBusy(true);
    try { await fd.unlink(subjectId, reason); toast(T("unlinked_done"), "unlink"); onDone(); }
    catch (e) { toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("error_generic"), "triangle-alert"); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} label={title} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
        <h2 className="t-h3" style={{ margin: 0 }}>{title}</h2>
        <span className="t-small t-muted">{T("unlink_body")}</span>
        <TextArea label={T("reason_label")} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} hint={T("reason_hint", { n: Math.min(reason.trim().length, LINK_REASON_MIN) })} autoFocus />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{T("cancel")}</Button>
          <Button variant="danger" icon="unlink" disabled={busy || reason.trim().length < LINK_REASON_MIN} onClick={() => void go()}>{T("unlink")}</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function ReviewQueue() {
  const s = useSession(); const T = useT(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [unlinking, setUnlinking] = useState<ReviewItem | null>(null);
  const isAdmin = s.me?.role === "admin";
  const load = useCallback(async () => { try { setItems((await fd.reviews()).items); setFailed(false); } catch { setFailed(true); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (p: { nameBn: string; nameEn: string | null }) => (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn);
  const keep = async (i: ReviewItem) => {
    try { await fd.keep(i.taskId); toast(T("kept_done"), "check"); await load(); }
    catch (e) { toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("error_generic"), "triangle-alert"); }
  };

  return (
    <div data-screen="fd/match-queue" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{T("review_queue_title")}</h1>
        <Button size="sm" icon="search" onClick={() => router.push("/m/fd/search")}>{T("back_to_search")}</Button>
      </div>
      <Callout icon="info">{isAdmin ? T("review_queue_admin_note") : T("review_queue_desk_note")}</Callout>
      {failed && <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>}
      {items && items.length === 0 && <PageState icon="shield-check" title={T("review_queue_empty")} body={T("no_patient_chosen_body")} />}
      {items?.map((i) => (
        <Card key={i.taskId} data-review={i.taskId} data-kind={i.kind} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {i.kind === "override" ? <Pill tone="warn" icon="link-2">{T("linked_with_override")}</Pill> : <Pill tone="info" icon="send">{T("waiting_for_review")}</Pill>}
            <b>{name(i.subject)}</b><span className="t-small t-muted num">{i.subject.facilityNo} · {L.age(i.subject)} {L.sex(i.subject.sex)}</span>
            {i.candidate && <><span className="t-muted">→</span><b>{name(i.candidate)}</b><span className="t-small t-muted num">{i.candidate.facilityNo} · {L.age(i.candidate)} {L.sex(i.candidate.sex)}</span></>}
          </span>
          {i.conflicts.length > 0 && <span className="t-small">{T("conflicts_note", { n: i.conflicts.length })}: {i.conflicts.map((f) => T(`f_${f}`)).join(", ")}</span>}
          {i.reason && <span className="t-small">{T("reason_label").replace(" *", "")}: “{i.reason}”</span>}
          <span className="t-small t-muted">{i.requestedBy ? (s.lang === "bn" ? i.requestedBy.nameBn : i.requestedBy.nameEn) : "—"} · <span className="num">{s.n(new Date(i.requestedAt).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "short", timeStyle: "short" }))}</span></span>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button size="sm" icon="git-compare" onClick={() => router.push(`/m/fd/match?id=${i.subject.id}`)}>{T("open_review")}</Button>
            {isAdmin && i.kind === "override" && <Button size="sm" variant="danger" icon="unlink" onClick={() => setUnlinking(i)}>{T("unlink")}</Button>}
            {isAdmin && i.kind === "override" && <Button size="sm" icon="check" onClick={() => void keep(i)}>{T("keep_link")}</Button>}
          </span>
        </Card>
      ))}
      <UnlinkDialog open={unlinking !== null} subjectId={unlinking?.subject.id ?? ""} onClose={() => setUnlinking(null)} onDone={() => { setUnlinking(null); void load(); }}
        title={unlinking ? T("unlink_title", { name: name(unlinking.subject), other: unlinking.candidate ? name(unlinking.candidate) : "—" }) : ""} />
    </div>
  );
}
