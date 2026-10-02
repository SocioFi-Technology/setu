"use client";
/* Writes the server refused after an offline save ("couldn't sync — check", open question 22). Each item shows what it
   was, when it was saved on this device and the server's reason; staff remove it once they have redone the work. */
import { useEffect, useState } from "react";
import { fill } from "@setu/i18n";
import { format } from "@setu/domain";
import { Button, Dialog, Icon } from "@setu/ui";
import { dismissRefused, refusedItems, type OutboxItem } from "../lib/outbox";
import { useSession } from "../lib/session";

export function RefusedSync() {
  const s = useSession();
  const T = (k: string, v: Record<string, string | number> = {}) => fill(s.t("shellApp", k), Object.fromEntries(Object.entries(v).map(([a, b]) => [a, typeof b === "number" ? s.n(b) : b])));
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<OutboxItem[]>([]);
  useEffect(() => { setItems(refusedItems()); if (s.refused === 0) setOpen(false); }, [s.refused]);
  if (s.refused === 0) return null;
  const label = (l: string) => { const k = `label_${l}`; const v = s.t("shellApp", k); return v === k ? l : v; };
  return (
    <>
      <button type="button" className="sync-pill off" data-testid="refused-sync" onClick={() => setOpen(true)} style={{ cursor: "pointer", border: 0 }}>
        <Icon name="triangle-alert" size={14} />{T("refused_pill", { n: s.refused })}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} label={T("refused_title")} width={560}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
          <h2 className="t-h3" style={{ margin: 0 }}>{T("refused_title")}</h2>
          <span className="t-small t-muted">{T("refused_body")}</span>
          {items.map((i) => (
            <div key={i.id} className="callout callout-warn" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }} data-testid="refused-item">
              <span style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 2 }}>
                <b>{label(i.label)}</b>
                <span>{s.lang === "bn" ? i.errorBn ?? i.error : i.error}</span>
                <span className="t-small t-muted">{T("refused_at", { at: format.dateTime(i.at, s.numerals === "bn") })}</span>
              </span>
              <Button size="sm" icon="check" onClick={() => { dismissRefused(i.id); setItems(refusedItems()); }}>{T("refused_dismiss")}</Button>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "flex-end" }}><Button onClick={() => setOpen(false)}>{T("close")}</Button></div>
        </div>
      </Dialog>
    </>
  );
}
