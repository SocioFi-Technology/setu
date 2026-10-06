"use client";
/* bill/pkg — the packages (ADR 0017, decision 5): read-only in this slice — each package's days, its price per bed class
   and what it includes and excludes; samples pending sign-off. Editing and the owner's publish step come later. */
import { useEffect, useState } from "react";
import type { PackageList } from "@setu/contracts";
import { Callout, Card, PageState, Pill } from "@setu/ui";
import { ipdBill } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useB, useErr, useMoney } from "./common";

export function BillPkg() {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr();
  const [list, setList] = useState<PackageList | null>(null); const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { ipdBill.packages().then(setList).catch((e) => setFailed(E(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!list) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const bn = s.lang === "bn";
  return (
    <div data-screen="bill/pkg" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{B("pk_title")}</h1>
      <span className="t-small t-muted">{B("pk_hint")} · {B("pk_readonly")}</span>
      {list.items.length === 0 && <PageState icon="package" title={B("pk_title")} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
        {list.items.map((p) => (
          <Card key={p.id} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-package={p.code}>
            <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <b>{bn ? p.nameBn : p.nameEn}</b><span className="num t-muted t-small">{p.code}</span>
              {p.sample && <Pill tone="warn">{B("r_sample")}</Pill>}
            </span>
            <span className="t-small">{B("ib_package_days", { n: p.days })}</span>
            <span className="t-small"><b>{B("pk_prices")}:</b> {Object.entries(p.prices).map(([c, x]) => `${c} ${M.tk(x)}`).join(" · ")}</span>
            <span className="t-small"><b>{B("ib_inc_items")}:</b> {p.items.filter((i) => i.kind !== "excluded").map((i) => `${bn ? i.nameBn : i.nameEn}${i.limit ? ` (${B("ib_limit", { n: i.limit })})` : ""}`).join(", ")}</span>
            <span className="t-small"><b>{B("ib_exc_items")}:</b> {p.items.filter((i) => i.kind === "excluded").map((i) => (bn ? i.nameBn : i.nameEn)).join(", ")}</span>
          </Card>
        ))}
      </div>
    </div>
  );
}
