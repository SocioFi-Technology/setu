"use client";
/* ph/stock — stock and expiry (ADR 0009). Ported from docs/prototype/Setu Pharmacy.dc.html ("Stock overview"): every
   medicine with what is usable at the counter and in the store, what expires within 90 days and what has expired,
   the batches behind it, and store → counter transfers (dispensing and sales pick from the counter only; an expired
   batch never goes to the counter). Filters: all / near expiry / expired / low at the counter. */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { BatchView, StockList } from "@setu/contracts";
import { Button, Callout, Card, Dialog, PageState, Pill, Segmented, SelectField, TextField, useToast } from "@setu/ui";
import { pharm } from "../../lib/api";
import { useSession } from "../../lib/session";
import { BatchState, ClassPill, MedName, NeedsServer, toInt, useErr, useFmt, useP } from "./common";

type Filter = "all" | "near-expiry" | "expired" | "low";

export function PhStock() {
  const P = useP(); const F = useFmt();
  const [q, setQ] = useState(""); const [filter, setFilter] = useState<Filter>("all");
  const [list, setList] = useState<StockList | null>(null); const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [moving, setMoving] = useState<BatchView | null>(null);
  const ask = useRef(0); // an older answer never replaces a newer search
  const load = useCallback(async () => { const n = ++ask.current; try { const x = await pharm.stock(q.trim(), filter); if (n === ask.current) { setList(x); setFailed(false); } } catch { if (n === ask.current) setFailed(true); } }, [q, filter]);
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); }, [load]);
  if (failed && !list) return <PageState icon="boxes" title={P("error_generic")} />;
  return (
    <div data-screen="ph/stock" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{P("stock_title")}</h1>
        <span style={{ marginLeft: "auto" }} />
        <Segmented label={P("filter")} value={filter} onChange={(f) => setFilter(f)} options={(["all", "near-expiry", "expired", "low"] as const).map((f) => ({ value: f, label: P(`f_${f}`) }))} />
      </div>
      <TextField label={P("find_medicine")} value={q} onChange={(e) => setQ(e.target.value)} data-testid="stock-search" />
      <NeedsServer />
      {!list ? <div aria-busy="true" className="t-muted">{P("loading")}</div> : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table className="table" style={{ width: "100%" }} data-testid="stock-table">
            <thead><tr><th>{P("medicine")}</th><th>{P("class")}</th><th className="num">{P("at_counter")}</th><th className="num">{P("in_store")}</th><th className="num">{P("near_expiry")}</th><th className="num">{P("expired")}</th><th /></tr></thead>
            <tbody>
              {list.items.length === 0 && <tr><td colSpan={7} className="t-muted">{P("nothing_here")}</td></tr>}
              {list.items.map((x) => (
                <Fragment key={x.medicine.key}>
                  <tr data-medicine={x.medicine.key}>
                    <td><MedName m={x.medicine} /></td>
                    <td><ClassPill c={x.medicine.saleClass} /></td>
                    <td className="num">{F.n(x.counterQty)}{x.low && <> <Pill tone="warn" icon="arrow-down">{P("low")}</Pill></>}</td>
                    <td className="num">{F.n(x.storeQty)}</td>
                    <td className="num">{x.nearExpiryQty > 0 ? <Pill tone="warn" icon="hourglass">{F.n(x.nearExpiryQty)}</Pill> : F.n(0)}</td>
                    <td className="num">{x.expiredQty > 0 ? <Pill tone="bad" icon="ban">{F.n(x.expiredQty)}</Pill> : F.n(0)}</td>
                    <td><Button size="sm" icon={open === x.medicine.key ? "chevron-up" : "chevron-down"} onClick={() => setOpen(open === x.medicine.key ? null : x.medicine.key)} data-testid="batches-toggle">{P("batches_n", { n: x.batches.length })}</Button></td>
                  </tr>
                  {open === x.medicine.key && (
                    <tr><td colSpan={7} style={{ background: "var(--surface-sunken)" }}>
                      <table className="table" style={{ width: "100%" }} data-testid="batch-table">
                        <thead><tr><th>{P("batch")}</th><th>{P("exp")}</th><th>{P("location")}</th><th className="num">{P("qty")}</th><th className="num">{P("mrp")}</th><th>{P("state")}</th><th /></tr></thead>
                        <tbody>
                          {x.batches.map((b) => (
                            <tr key={b.id} data-batch={b.batchNo} data-location={b.location}>
                              <td className="num">{b.batchNo}{b.sample ? <span className="t-small t-muted"> · {P("sample")}</span> : null}</td>
                              <td className="num">{F.day(b.expiry)}</td><td>{P(`loc_${b.location}`)}</td><td className="num">{F.n(b.qtyOnHand)}</td><td className="num">{F.tk(b.mrpPaisa)}</td>
                              <td><BatchState b={b} /></td>
                              <td>{b.qtyOnHand > 0 && b.location !== "quarantine" && <Button size="sm" icon="arrow-right-left" data-testid="transfer" onClick={() => setMoving(b)}>{P("move")}</Button>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <Dialog open={!!moving} onClose={() => setMoving(null)} label={P("move_title")}>
        {moving && <MoveForm b={moving} onDone={async () => { setMoving(null); await load(); }} />}
      </Dialog>
    </div>
  );
}

function MoveForm({ b, onDone }: { b: BatchView; onDone: () => Promise<void> }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const toast = useToast();
  const targets = (["counter", "store", "fridge"] as const).filter((x) => x !== b.location && (x === "store" || b.state !== "expired"));
  const [to, setTo] = useState<"counter" | "store" | "fridge">(targets[0] ?? "store");
  const [qty, setQty] = useState(String(Math.min(b.qtyOnHand, 100))); const [busy, setBusy] = useState(false); const [key] = useState(() => crypto.randomUUID());
  const n = toInt(qty);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span><b className="num">{b.batchNo}</b> · {P("exp")} <span className="num">{F.day(b.expiry)}</span> · {P(`loc_${b.location}`)} · <span className="num">{F.n(b.qtyOnHand)}</span></span>
      {b.state === "expired" && <Callout tone="bad" icon="ban">{P("expired_store_only")}</Callout>}
      <SelectField label={P("move_to")} value={to} onChange={(e) => setTo(e.target.value as typeof to)} data-testid="move-to">
        {targets.map((x) => <option key={x} value={x}>{P(`loc_${x}`)}</option>)}
      </SelectField>
      <TextField label={P("qty")} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="move-qty" error={n !== null && n > b.qtyOnHand ? P("more_than_batch") : undefined} />
      <Button variant="primary" icon="arrow-right-left" data-testid="move-confirm" disabled={!s.online || busy || !targets.length || !n || n > b.qtyOnHand}
        onClick={async () => { setBusy(true); try { await pharm.transfer({ batchId: b.id, qty: n!, to }, key); toast(P("moved_ok"), "check"); await onDone(); } catch (e) { toast(E(e), "triangle-alert"); } finally { setBusy(false); } }}>
        {P("move")}
      </Button>
    </div>
  );
}
