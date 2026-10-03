"use client";
/* doc/consult — quick consult on the phone (walkthrough A12, issue #8). The same note editor as the desk (autosave with
   "Not yet synced", device drafts offline, the allergy check on every medicine, the PIN sign sheet that is final only
   after the server answers) laid out for a phone: the patient's name, token and allergies stay on screen, the button
   reads "Sign & send". After signing: the server-confirmed time, the prescription and Print (A13). */
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ConsultationView } from "@setu/contracts";
import { Button, Callout, Card, PageState, Pill } from "@setu/ui";
import { PrintPanel } from "../../components/PrintPanel";
import { cons } from "../../lib/api";
import { useSession } from "../../lib/session";
import { ConsultEditor } from "../cons/Draft";
import { ConsNavContext, consUrl, useBanner, useC, type ConsNav } from "../cons/common";
import { DocFrame, docUrl, useD, useDF } from "./common";

const PHONE_NAV: ConsNav = {
  phone: true,
  list: () => docUrl("queue"),
  draft: (e) => docUrl("consult", e),
  signed: (e) => `${docUrl("consult", e)}&signed=1`,
};

export function DocConsult() {
  const q = useSearchParams(); const D = useD(); const router = useRouter();
  const enc = q.get("enc"); const signed = q.get("signed") === "1";
  if (!enc) return <DocFrame tab="consult"><PageState icon="stethoscope" title={D("c_pick")} /><Button icon="ticket" onClick={() => router.push(docUrl("queue"))}>{D("tab_queue")}</Button></DocFrame>;
  return (
    <DocFrame tab="consult">
      {signed ? <SignedView key={enc} encounterId={enc} /> : <ConsNavContext.Provider value={PHONE_NAV}><ConsultEditor encounterId={enc} /></ConsNavContext.Provider>}
    </DocFrame>
  );
}

function SignedView({ encounterId }: { encounterId: string }) {
  const s = useSession(); const D = useD(); const C = useC(); const F = useDF(); const router = useRouter(); const banner = useBanner();
  const [v, setV] = useState<ConsultationView | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { cons.view(encounterId).then((x) => { setV(x); s.setPatient(banner(x)); }).catch(() => setFailed(true)); }, [encounterId]); // eslint-disable-line react-hooks/exhaustive-deps
  // a draft (e.g. an amendment) is still open: back to the editor — a draft is never shown as signed
  const open = !!v && (!!v.draft || !v.current);
  useEffect(() => { if (open) router.replace(PHONE_NAV.draft(encounterId)); }, [open, encounterId, router]);
  if (failed) return <Callout tone="warn" icon="triangle-alert">{D("error_generic")}</Callout>;
  if (!v || open) return <div aria-busy="true" className="t-muted">{D("loading")}</div>;
  const c = v.current!;
  return (
    <div data-screen="doc/signed" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <b className="t-body">{F.name(v.encounter.patient)} · <span className="num">{v.encounter.token}</span></b>
      <Callout icon="shield-check" data-testid="doc-signed">{D("c_signed", { at: F.dateTime(c.signedAt ?? "") })}</Callout>
      <Card style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }} data-testid="doc-rx">
        <b>{D("c_rx")} <Pill tone="final" icon="shield-check">v{s.n(c.version)}</Pill></b>
        {c.medications.map((m, n) => (
          <span key={n} className="t-small"><b>{m.form} {m.brand} {m.strength}</b> <i>({m.generic})</i><br /><span className="num">{F.num(m.dose)}</span> · {C(`meal_${m.meal}`)} · {D("days_n", { n: m.days })}</span>
        ))}
      </Card>
      <PrintPanel kind="rx" id={c.id} compact />
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button icon="arrow-left" onClick={() => router.push(docUrl("queue"))}>{D("c_back")}</Button>
        <Button variant="ghost" icon="external-link" onClick={() => router.push(consUrl("signed", encounterId))}>{D("c_full")}</Button>
      </span>
    </div>
  );
}
