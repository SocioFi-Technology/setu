"use client";
/* Screens are ported from docs/prototype/<module>.dc.html one journey slice at a time and registered here.
   Until then a screen shows the placeholder below, which names the slice that brings it. */
import type { ComponentType } from "react";
import { PageState } from "@setu/ui";
import { useSession } from "../lib/session";
import { BillApprovals } from "./bill/Approvals";
import { BillOpd } from "./bill/Opd";
import { BillPay } from "./bill/Pay";
import { BillReceipt } from "./bill/Receipt";
import { BillReconcile } from "./bill/Reconcile";
import { BillShift } from "./bill/Shift";
import { OwnerDash } from "./own/Dash";
import { ConsultDraft } from "./cons/Draft";
import { ConsultAmended, ConsultSigned } from "./cons/Signed";
import { DocConsult } from "./doc/Consult";
import { DocHome } from "./doc/Home";
import { DocInbox } from "./doc/Inbox";
import { DocQueue } from "./doc/Queue";
import { FrontDeskMatch } from "./fd/Match";
import { FrontDeskQueue } from "./fd/Queue";
import { FrontDeskRegister } from "./fd/Register";
import { FrontDeskSearch } from "./fd/Search";
import { FrontDeskVitals } from "./fd/Vitals";
import { LabAccession } from "./lab/Accession";
import { LabCollect } from "./lab/Collect";
import { LabDelivery } from "./lab/Delivery";
import { LabReport } from "./lab/Report";
import { LabResultEntry } from "./lab/Result";
import { LabVerify } from "./lab/Verify";

const SCREENS: Record<string, ComponentType> = {
  // slice A1–A3
  "fd/search": FrontDeskSearch,
  "fd/match": FrontDeskMatch,
  "fd/register": FrontDeskRegister,
  "fd/queue": FrontDeskQueue,
  // slice A4
  "fd/vitals": FrontDeskVitals,
  // slice A5
  "cons/draft": ConsultDraft,
  "cons/signed": ConsultSigned,
  "cons/amended": ConsultAmended,
  // slice A6–A7
  "bill/opd": BillOpd,
  "bill/pay": BillPay,
  "bill/receipt": BillReceipt,
  "bill/approvals": BillApprovals,
  // billing follow-ups (ADR 0005)
  "bill/reconcile": BillReconcile,
  // slice A8–A11
  "lab/collect": LabCollect,
  "lab/accession": LabAccession,
  "lab/result": LabResultEntry,
  "lab/verify": LabVerify,
  "lab/report": LabReport,
  "lab/delivery": LabDelivery,
  // slice A12–A13: the doctor app at phone width
  "doc/home": DocHome,
  "doc/queue": DocQueue,
  "doc/consult": DocConsult,
  "doc/inbox": DocInbox,
  // slice C1–C4: shift close and the owner dashboard
  "bill/shift": BillShift,
  "own/dash": OwnerDash,
};
const SLICE: Record<string, string> = { fd: "A1–A3", cons: "A4–A5", bill: "A6–A7", lab: "A8–A11", doc: "A12–A13", ph: "phase 2", own: "C1–C4", adm: "phase 2", er: "B1–B2", ipd: "B3–B4", nur: "B5–B6", net: "E1–E4" };

export function ModuleScreen({ mod, screen }: { mod: string; screen: string }) {
  const s = useSession();
  const Cmp = SCREENS[`${mod}/${screen}`];
  if (Cmp) return <div className="module-page"><Cmp /></div>;
  const m = s.caps?.modules.find((x) => x.key === mod); const sc = m?.screens.find((x) => x.key === screen);
  const name = sc ? (s.lang === "bn" ? sc.name_bn : sc.name_en) : screen;
  return (
    <PageState icon={sc?.icon ?? "layout-template"} title={name}
      body={s.L(`এই স্ক্রিনটি স্লাইস ${SLICE[mod] ?? "—"}-এ প্রোটোটাইপ থেকে পোর্ট হবে।`, `This screen is ported from the prototype in slice ${SLICE[mod] ?? "—"}.`)}
      foot={`${mod}/${screen}`} />
  );
}
