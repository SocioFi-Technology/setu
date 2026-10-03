"use client";
/* lab/delivery — walkthrough A11. Ported from docs/prototype/Setu Lab.dc.html (screen "Report delivery").
   Opens on the visit's current released version (from Release it lands here already released — walkthrough issue #2,
   where every Send was disabled while the log said "released"). Channels: SMS (a fixed text — facility name, "your
   report is ready, collect at the lab counter"; never a result, a test or a name), the patient app (recorded as
   "available in the app" until Journey D), and the doctor's inbox (sent automatically on every release, decision D6).
   Each channel shows its own status; a failed SMS is retried with the same message id, so it is never delivered twice.
   A superseded version is not sent: the screen says to send the new one. Sending needs a connection. */
import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CommunicationItem, LabVisitView } from "@setu/contracts";
import { Button, Callout, Card, PageState, Pill, useToast } from "@setu/ui";
import { lab } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLabels } from "../fd/common";
import { COMM_TONE, REPORT_TONE, VisitHead, isLabWriter, useErr, useFmt, useLabVisit, useLb } from "./common";
import { LabWorklist } from "./Worklist";

export function LabDelivery() {
  const enc = useSearchParams().get("enc");
  return enc ? <DeliveryVisit encounterId={enc} /> : <LabWorklist stage="delivery" />;
}

function DeliveryVisit({ encounterId }: { encounterId: string }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const E = useErr(); const L = useLabels(); const toast = useToast(); const router = useRouter();
  const { v, show, reload, failed } = useLabVisit(encounterId);
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});
  const key = (k: string) => (keys.current[k] ??= crypto.randomUUID());
  if (failed) return failed === "not_found" ? <PageState icon="search-x" title={T("not_found")} /> : <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{T("loading")}</div>;
  const cur = v.reports.find((r) => r.status !== "superseded") ?? null;
  const writer = isLabWriter(s.me?.role, "deliver");
  const forCur = (kind: string) => (cur ? [...v.communications].reverse().find((c) => c.reportId === cur.id && c.kind === kind) ?? null : null);
  const act = async (k: string, fn: () => Promise<LabVisitView>) => {
    setBusy(k);
    try { const x = await fn(); delete keys.current[k]; show(x); }
    catch (e) { delete keys.current[k]; toast(E(e), "triangle-alert"); await reload(); } finally { setBusy(null); }
  };
  const sms = forCur("report-ready"), app = forCur("report-app"), inbox = forCur("report-inbox");
  // a send that was interrupted (queued > 1 min, in progress > 2 min) can be retried like a failed one
  const stuck = (c: CommunicationItem) => (c.status === "preparation" && Date.now() - Date.parse(c.createdAt) > 60_000) || (c.status === "in-progress" && Date.now() - Date.parse(c.sentAt ?? c.createdAt) > 120_000);
  const older = v.reports.filter((r) => r.status === "superseded" && v.communications.some((c) => c.reportId === r.id && (c.kind === "report-ready" || c.kind === "report-app")));
  return (
    <div data-screen="lab/delivery" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <VisitHead v={v} title={T("delivery_title")} right={cur ? <span data-report-version={cur.version}><Pill tone={REPORT_TONE[cur.status] ?? "neu"} icon="file-text">{cur.number} v{s.n(cur.version)} · {T(`rep_${cur.status}`)}</Pill></span> : undefined} />
      {!cur ? <Callout tone="warn" icon="lock" data-testid="not-released">{T("not_released")}</Callout> : (
        <Callout tone="info" icon="circle-check" data-testid="released">{T("released_line", { number: cur.number, v: cur.version, at: F.dateTime(cur.releasedAt), name: F.name(cur.releasedBy) })}{cur.pendingCount > 0 ? ` · ${T("wm_preliminary", { n: cur.pendingCount, m: cur.testCount })}` : ""}</Callout>
      )}
      {older.length > 0 && cur && <Callout tone="warn" icon="history">{T("resend_new", { v: cur.version })}</Callout>}
      {!s.online && <Callout tone="warn" icon="cloud-off">{T("online_needed")}</Callout>}
      {cur && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <Channel icon="message-square" title={T("ch_sms")} to={v.patient.phone ? L.phone(v.patient.phone) : T("no_mobile")} c={sms} data="sms"
            note={T("sms_no_results")}
            action={writer && s.online && (!sms ? <Button variant="primary" icon="send" data-testid="send-sms" disabled={!!busy || !v.patient.phone} onClick={() => void act("sms", () => lab.send(cur.id, "sms", key("sms")))}>{T("send")}</Button>
              : sms.status === "failed" || stuck(sms) ? <Button variant="primary" icon="rotate-ccw" data-testid="retry-sms" disabled={!!busy} onClick={() => void act(`retry:${sms.id}`, () => lab.retry(sms.id, key(`retry:${sms.id}`)))}>{T("retry")}</Button> : null)} />
          <Channel icon="smartphone" title={T("ch_app")} to={T("ch_app_to")} c={app} data="app" note={T("ch_app_note")}
            action={writer && s.online && !app && <Button variant="primary" icon="send" data-testid="send-app" disabled={!!busy} onClick={() => void act("app", () => lab.send(cur.id, "patient-app", key("app")))}>{T("send")}</Button>} />
          <Channel icon="inbox" title={T("ch_inbox")} to={inbox?.recipient ? F.name(inbox.recipient) : "—"} c={inbox} data="inbox" note={T("ch_inbox_note")} action={null} recordOnly />
        </div>
      )}
      {process.env.NODE_ENV !== "production" && writer && cur && (
        <span className="t-small t-muted" style={{ display: "flex", gap: 8, alignItems: "center" }} data-testid="dev-sms">
          {T("dev_only")} <Button size="sm" variant="ghost" icon="bug" onClick={async () => { try { await lab.failNextSms(); toast(T("dev_fail_next_done"), "bug"); } catch (e) { toast(E(e), "triangle-alert"); } }}>{T("dev_fail_next")}</Button>
        </span>
      )}
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" data-testid="event-log">
          <thead><tr><th>{T("ev_event")}</th><th>{T("ev_channel")}</th><th>{T("col_status")}</th><th>{T("ev_time")}</th><th>{T("ev_to")}</th></tr></thead>
          <tbody>
            {[...v.reports].reverse().map((r) => (
              <tr key={r.id} data-event="release"><td>{T("ev_released", { number: r.number, v: r.version, status: T(`rep_${r.status}`) })}</td><td>—</td><td><Pill tone={REPORT_TONE[r.status] ?? "neu"}>{T(`rep_${r.status}`)}</Pill></td><td className="num">{F.dateTime(r.releasedAt)}</td><td>{F.name(r.releasedBy)}</td></tr>
            ))}
            {[...v.communications].reverse().map((c) => (
              <tr key={c.id} data-event={c.kind} data-status={c.status}>
                <td>{T(`ck_${c.kind}`)}{c.reportVersion ? ` · v${s.n(c.reportVersion)}` : ""}</td><td>{T(`ch_${c.channel}`)}</td>
                <td><Pill tone={COMM_TONE[c.status] ?? "neu"}>{c.channel === "doctor-inbox" && c.status === "completed" ? T("cs_inbox_recorded") : T(`cs_${c.status}`)}</Pill>{c.lastError && <div className="t-small">{c.lastError}</div>}{c.attempts > 1 && <div className="t-small t-muted">{T("attempts", { n: c.attempts })}</div>}</td>
                <td className="num">{F.dateTime(c.completedAt ?? c.sentAt ?? c.createdAt)}</td><td>{c.recipient ? F.name(c.recipient) : c.toPhone ? L.phone(c.toPhone.slice(1)) : c.channel === "patient-app" ? T("ch_app_to") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {cur && <span><Button icon="file-text" onClick={() => router.push(`/m/lab/report?id=${encodeURIComponent(cur.id)}`)}>{T("open_report")}</Button></span>}
    </div>
  );
}

function Channel({ icon, title, to, c, note, action, data, recordOnly }: { icon: string; title: string; to: string; c: CommunicationItem | null; note: string; action: React.ReactNode; data: string; recordOnly?: boolean }) {
  const T = useLb(); const F = useFmt();
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8, borderColor: c?.status === "failed" ? "var(--danger-border)" : undefined }} data-channel={data} data-status={c?.status ?? "not-sent"}>
      <span style={{ display: "flex", gap: 8, alignItems: "center" }}><b>{title}</b></span>
      <span className="t-small t-muted num">{to}</span>
      <span>{c ? <Pill tone={COMM_TONE[c.status] ?? "neu"} icon={icon}>{recordOnly && c.status === "completed" ? T("cs_inbox_recorded") : T(`cs_${c.status}`)}</Pill> : <Pill tone="neu" icon={icon}>{T("cs_not_sent")}</Pill>}</span>
      {c?.lastError && <span className="t-small" style={{ color: "var(--danger-fg, #b91c1c)" }}>{T("failed_why", { why: c.lastError })}</span>}
      {c && <span className="t-small t-muted">{F.dateTime(c.completedAt ?? c.sentAt ?? c.createdAt)}{c.attempts > 1 ? ` · ${T("attempts", { n: c.attempts })}` : ""}</span>}
      <span className="t-small t-muted">{note}</span>
      {action}
    </Card>
  );
}
