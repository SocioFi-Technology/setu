"use client";
/* adm/audit — journey G4 (ADR 0010). Ported from docs/prototype/Setu Admin.dc.html ("Audit log"): this facility's events
   (the owner also sees sign-ins and public QR checks), newest first — who, when, what, which patient, from where — with
   filters (dates, action, flags only) and a CSV download of what the filters show (the download is itself recorded and
   flagged). Flags: reprints, voids, exports, switch-offs, role changes, password resets, price and settings changes,
   go-live. Opening this list is recorded too. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditPage, AuditQuery } from "@setu/contracts";
import { Button, Callout, Card, PageState, Pill, SelectField, TextField } from "@setu/ui";
import { adm } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useA, useFmt } from "./common";

const ACTIONS = ["", "view", "create", "update", "sign", "print", "reprint", "void", "export", "deactivate", "reactivate", "role-change", "reset-password", "first-sign-in", "price-change", "settings-change", "go-live", "login", "break-glass"];

export function AdmAudit() {
  const s = useSession(); const A = useA(); const F = useFmt();
  const [q, setQ] = useState<AuditQuery>({ flagged: "1" });
  const [page, setPage] = useState<AuditPage | null>(null); const [failed, setFailed] = useState(false); const [more, setMore] = useState(false);
  // only the latest request's answer is shown (a slow answer for older filters never overwrites newer ones)
  const latest = useRef(0);
  const load = useCallback(async (filters: AuditQuery) => {
    const n = ++latest.current; setFailed(false);
    try { const p = await adm.audit(filters); if (n === latest.current) setPage(p); } catch { if (n === latest.current) setFailed(true); }
  }, []);
  /** the action and the record in the reader's language (an unknown code shows as it is) */
  const label = (prefix: "act" | "ent", code: string) => { const t = A(`${prefix}_${code}`); return t === `${prefix}_${code}` ? code : t; };
  useEffect(() => { void load(q); s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = (patch: Partial<AuditQuery>) => { const n = { ...q, ...patch }; Object.keys(n).forEach((k) => { if (!n[k as keyof AuditQuery]) delete n[k as keyof AuditQuery]; }); setQ(n); setPage(null); void load(n); };
  return (
    <div data-screen="adm/audit" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{A("audit_title")}</h1>
        <span className="t-small t-secondary">{s.me?.role === "owner" ? A("audit_scope_owner") : A("audit_scope_admin")}</span>
        <span style={{ marginLeft: "auto" }} />
        <a className="btn" href={adm.auditCsvHref(q)} data-testid="audit-csv" download>{A("download_csv")}</a>
      </div>
      <Card style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: 12, flexWrap: "wrap" }} data-testid="audit-filters">
        <TextField label={A("from")} type="date" value={q.from ?? ""} onChange={(e) => apply({ from: e.target.value || undefined })} data-testid="f-from" />
        <TextField label={A("to")} type="date" value={q.to ?? ""} onChange={(e) => apply({ to: e.target.value || undefined })} data-testid="f-to" />
        <SelectField label={A("action")} value={q.action ?? ""} onChange={(e) => apply({ action: e.target.value || undefined })} data-testid="f-action">
          {ACTIONS.map((a) => <option key={a} value={a}>{a ? label("act", a) : A("all")}</option>)}
        </SelectField>
        <label style={{ display: "flex", gap: 6, alignItems: "center", paddingBottom: 8 }}>
          <input type="checkbox" checked={q.flagged === "1"} onChange={(e) => apply({ flagged: e.target.checked ? "1" : undefined })} data-testid="f-flagged" /> {A("flags_only")}
        </label>
      </Card>
      {failed ? <Callout tone="warn" icon="triangle-alert">{A("error_generic")}</Callout>
        : !page ? <div aria-busy="true" className="t-muted">{A("loading")}</div>
        : page.items.length === 0 ? <PageState icon="scroll-text" title={A("audit_empty")} />
        : (
          <Card style={{ padding: 0, overflowX: "auto" }}>
            <table className="table" style={{ width: "100%" }} data-testid="audit-table">
              <thead><tr><th>{A("when")}</th><th>{A("who")}</th><th>{A("action")}</th><th>{A("what")}</th><th>{A("patient")}</th><th>{A("from_where")}</th></tr></thead>
              <tbody>
                {page.items.map((x) => (
                  <tr key={x.id} data-action={x.action} data-flagged={x.flagged ? "1" : "0"}>
                    <td className="num t-small" style={{ whiteSpace: "nowrap" }}>{F.dateTime(x.at)}</td>
                    <td>{x.user ? F.name(x.user) : A("system")}<span className="t-small t-muted">{x.role ? ` · ${A(`role_${x.role}`)}` : ""}</span></td>
                    <td>{x.flagged ? <Pill tone="warn" icon="flag">{label("act", x.action)}</Pill> : <span className="t-small">{label("act", x.action)}</span>}</td>
                    <td className="t-small" style={{ maxWidth: 420 }}>{label("ent", x.entity)}{x.summary ? ` · ${x.summary}` : ""}</td>
                    <td className="t-small">{x.patient ? <>{F.name(x.patient)} · <span className="num">{x.patient.facilityNo}</span></> : "—"}</td>
                    <td className="num t-small">{x.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      {page?.next && (
        <span><Button icon="chevrons-down" data-testid="audit-more" disabled={more} onClick={async () => {
          setMore(true); const n = latest.current;
          try { const next = await adm.audit({ ...q, before: page.next! }); if (n === latest.current) setPage((cur) => (cur ? { items: [...cur.items, ...next.items], next: next.next } : cur)); }
          catch { if (n === latest.current) setFailed(true); }
          finally { setMore(false); }
        }}>{A("load_more")}</Button></span>
      )}
    </div>
  );
}
