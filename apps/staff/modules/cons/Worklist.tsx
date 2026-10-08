"use client";
/* The doctor's list for today (decision 28: their own visits plus the unassigned waiting ones at this branch). */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConsultWorklist as Worklist } from "@setu/contracts";
import { Button, Callout, PageState, Pill } from "@setu/ui";
import { cons } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLabels } from "../fd/common";
import { consUrl, useC, useFmt } from "./common";

/* Hands-on test 03/10/2026: finished visits came first (token order) and pushed the waiting patient off the screen.
   Order: with this doctor → waiting (critical first) → completed; token order within each group. */
const RANK: Record<string, number> = { "in-progress": 0, triaged: 1, arrived: 1, finished: 2 };
const ordered = (items: Worklist["items"]) =>
  items.map((x, i) => ({ x, i })).sort((a, b) => (RANK[a.x.status] ?? 3) - (RANK[b.x.status] ?? 3) || Number(b.x.critical) - Number(a.x.critical) || a.i - b.i).map((y) => y.x);

export function ConsultWorklist() {
  const s = useSession(); const C = useC(); const F = useFmt(); const L = useLabels(); const router = useRouter();
  const [w, setW] = useState<Worklist | null>(null); const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false); // the seen visits: the latest few unless asked (ADR 0019 load check)
  useEffect(() => { s.setPatient(null); cons.worklist(showAll).then(setW).catch(() => setFailed(true)); }, [showAll]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{C("error_generic")}</Callout>;
  if (!w) return <div aria-busy="true" className="t-muted">{C("loading")}</div>;
  return (
    <div data-screen="cons/worklist" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{C("title_worklist")}</h1>
      {w.items.length === 0 ? <PageState icon="stethoscope" title={C("worklist_empty")} /> : (
        <>
          <span className="t-muted">{C("worklist_hint")}</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {ordered(w.items).map((i) => (
              <button key={i.id} type="button" className="card" data-cons-token={i.token} data-status={i.status}
                onClick={() => router.push(consUrl(i.signed && !i.hasDraft ? "signed" : "draft", i.id))}
                style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14, textAlign: "left", cursor: "pointer" }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <b className="num" style={{ fontSize: 18 }}>{i.token}</b>
                  <Pill tone={i.status === "finished" ? "ok" : i.status === "in-progress" ? "info" : "neu"}>{C(`st_${i.status}`)}</Pill>
                  {i.critical && <Pill tone="crit" icon="siren">{C("critical")}</Pill>}
                </span>
                <b>{F.name(i.patient)}</b>
                <span className="t-small t-muted num">{i.patient.facilityNo} · {L.age(i.patient)} {L.sex(i.patient.sex)}</span>
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Pill tone="neu" icon={i.mine ? "user-check" : "user"}>{i.mine ? C("w_mine") : C("w_unassigned")}</Pill>
                  {i.hasDraft && <Pill tone="draft" icon="pen-line">{C("w_draft")}</Pill>}
                  {i.signed && <Pill tone="final" icon="shield-check">{C("w_signed")}</Pill>}
                </span>
              </button>
            ))}
          </div>
          {w.doneTotal > w.items.filter((i) => i.status === "finished").length && (
            <span className="t-small t-muted" data-testid="recent-of-done">
              {C("recent_of", { n: w.items.filter((i) => i.status === "finished").length, total: w.doneTotal })} · <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>{C("show_all")}</Button>
            </span>
          )}
        </>
      )}
    </div>
  );
}
