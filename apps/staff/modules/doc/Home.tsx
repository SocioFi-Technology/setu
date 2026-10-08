"use client";
/* doc/home — the doctor's day at a glance (shell-roles-plans: "my queue, results to review, unsigned notes"). Live counts
   from the server (the prototype's sample chambers and earnings come with later journeys). */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConsultWorklist, InboxView } from "@setu/contracts";
import { Button, Callout, Card, Pill } from "@setu/ui";
import { cons, doctor } from "../../lib/api";
import { useSession } from "../../lib/session";
import { DocFrame, docUrl, rememberUnread, useD, useDF } from "./common";

export function DocHome() {
  const s = useSession(); const D = useD(); const F = useDF(); const router = useRouter();
  const [w, setW] = useState<ConsultWorklist | null>(null);
  const [inbox, setInbox] = useState<InboxView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    s.setPatient(null);
    Promise.all([cons.worklist(), doctor.inbox()]).then(([a, b]) => { setW(a); setInbox(b); rememberUnread(b.counts.unread); }).catch(() => setFailed(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = w?.items.filter((i) => i.mine) ?? [];
  const tiles = w && inbox ? [
    { k: "waiting", n: w.items.filter((i) => i.status === "arrived" || i.status === "triaged").length, label: D("h_waiting") },
    { k: "seen", n: w.doneTotal, label: D("h_seen") },
    { k: "drafts", n: mine.filter((i) => i.hasDraft).length, label: D("h_drafts") },
    { k: "results", n: inbox.counts.unread, label: D("h_results") },
  ] : [];
  return (
    <DocFrame tab="home">
      <span className="t-small t-muted">{D("today", { date: F.date(new Date()) })}</span>
      <h1 className="t-h2" style={{ margin: 0 }}>{D("hello", { name: s.lang === "bn" ? s.me?.nameBn ?? "" : s.me?.nameEn ?? "" })}</h1>
      <span className="t-small t-muted">{s.me?.organizationName ?? ""}</span>
      {failed && <Callout tone="warn" icon="triangle-alert">{D("error_generic")}</Callout>}
      {!failed && !w && <div aria-busy="true" className="t-muted">{D("loading")}</div>}
      {w && inbox && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} data-testid="doc-tiles">
            {tiles.map((t) => (
              <Card key={t.k} data-tile={t.k} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="t-small t-secondary">{t.label}</span>
                <b className="num" style={{ fontSize: 26, lineHeight: "32px" }}>{s.n(t.n)}</b>
                {t.k === "results" && inbox.counts.critical > 0 && <span data-testid="home-critical"><Pill tone="crit" icon="siren">{D("h_critical", { n: inbox.counts.critical })}</Pill></span>}
              </Card>
            ))}
          </div>
          <Button variant="primary" icon="ticket" onClick={() => router.push(docUrl("queue"))}>{D("h_open_queue")}</Button>
          <Button icon="file-text" onClick={() => router.push(docUrl("inbox"))}>{D("h_open_inbox")}</Button>
          <span className="t-small t-muted">{D("h_live")}</span>
        </>
      )}
    </DocFrame>
  );
}
