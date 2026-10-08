"use client";
/* doc/queue — today's patients on the phone (prototype "Queue"): with you now, waiting (critical vital signs first),
   completed. Same list and rules as the desk worklist (decision 28): the doctor's own visits plus unassigned waiting
   ones at this branch. Tapping opens the quick consult. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConsultWorklist } from "@setu/contracts";
import { Button, Callout, PageState, Pill } from "@setu/ui";
import { cons } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLabels } from "../fd/common";
import { DocFrame, docUrl, useD, useDF } from "./common";

type Item = ConsultWorklist["items"][number];

export function DocQueue() {
  const s = useSession(); const D = useD(); const F = useDF(); const L = useLabels(); const router = useRouter();
  const [w, setW] = useState<ConsultWorklist | null>(null); const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false); // the seen visits: the latest few unless asked (ADR 0019 load check)
  useEffect(() => { s.setPatient(null); cons.worklist(showAll).then(setW).catch(() => setFailed(true)); }, [showAll]); // eslint-disable-line react-hooks/exhaustive-deps
  const byToken = (a: Item, b: Item) => a.token.localeCompare(b.token, "en", { numeric: true });
  const now = (w?.items ?? []).filter((i) => i.status === "in-progress").sort(byToken);
  const waiting = (w?.items ?? []).filter((i) => i.status === "arrived" || i.status === "triaged").sort((a, b) => Number(b.critical) - Number(a.critical) || byToken(a, b));
  const done = (w?.items ?? []).filter((i) => i.status === "finished").sort(byToken);

  const card = (i: Item, big = false) => (
    <button key={i.id} type="button" className="card" data-doc-token={i.token} data-status={i.status} onClick={() => router.push(docUrl("consult", i.id))}
      style={{ display: "flex", gap: 12, alignItems: "center", padding: big ? 14 : 12, textAlign: "left", cursor: "pointer", width: "100%", border: big ? "2px solid var(--brand-primary)" : undefined }}>
      <b className="num" style={{ fontSize: big ? 22 : 18, minWidth: 64 }}>{i.token}</b>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
        <b style={{ overflowWrap: "anywhere" }}>{F.name(i.patient)}</b>
        <span className="t-small t-muted num">{L.age(i.patient)} {L.sex(i.patient.sex)} · {i.patient.facilityNo}</span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {i.critical && <Pill tone="crit" icon="siren">{D("q_critical")}</Pill>}
          {i.hasDraft && <Pill tone="draft" icon="pen-line">{D("q_draft")}</Pill>}
          {i.status === "in-progress" && !i.mine && <Pill tone="neu" icon="user">{D("q_other_doctor")}</Pill>}
        </span>
      </span>
      <span className="t-small" style={{ color: "var(--brand-primary-text)", fontWeight: 600 }}>{i.status === "finished" ? D("q_view") : i.status === "in-progress" ? D("q_continue") : D("q_start")}</span>
    </button>
  );
  return (
    <DocFrame tab="queue">
      <h1 className="t-h2" style={{ margin: 0 }}>{D("q_title")}</h1>
      {failed && <Callout tone="warn" icon="triangle-alert">{D("error_generic")}</Callout>}
      {!failed && !w && <div aria-busy="true" className="t-muted">{D("loading")}</div>}
      {w && w.items.length === 0 && <PageState icon="ticket" title={D("q_empty")} />}
      {now.length > 0 && <section data-group="now" style={{ display: "flex", flexDirection: "column", gap: 8 }}><span className="t-small t-secondary"><b>{D("q_now")}</b></span>{now.map((i) => card(i, true))}</section>}
      {waiting.length > 0 && <section data-group="waiting" style={{ display: "flex", flexDirection: "column", gap: 8 }}><span className="t-small t-secondary"><b>{D("q_waiting")}</b> · <span className="num">{s.n(waiting.length)}</span></span>{waiting.map((i) => card(i))}</section>}
      {done.length > 0 && <section data-group="done" style={{ display: "flex", flexDirection: "column", gap: 8 }}><span className="t-small t-secondary"><b>{D("q_done")}</b> · <span className="num">{s.n(w?.doneTotal ?? done.length)}</span></span>{done.map((i) => card(i))}
        {w && w.doneTotal > done.length && <span className="t-small t-muted" data-testid="recent-of-done">{D("recent_of", { n: done.length, total: w.doneTotal })} · <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>{D("show_all")}</Button></span>}</section>}
    </DocFrame>
  );
}
