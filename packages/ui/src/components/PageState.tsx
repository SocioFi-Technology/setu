import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { Card } from "./Card";
/** Permission-denied, Not-in-plan, empty, 404 and "coming in slice" states share one layout (DS 5). */
export function PageState({ icon, title, body, lines, actions, foot }: { icon: string; title: string; body?: ReactNode; lines?: { icon: string; text: string }[]; actions?: ReactNode; foot?: ReactNode }) {
  return (
    <div className="state-wrap">
      <Card className="state-card">
        <span className="state-icon"><Icon name={icon} size={24} /></span>
        <h2 className="t-h2">{title}</h2>
        {body && <p className="t-body t-secondary" style={{ margin: 0 }}>{body}</p>}
        {lines && <div style={{ display: "flex", flexDirection: "column", gap: 4, font: "500 13px/20px var(--font-sans)" }}>{lines.map((l, i) => <span key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}><Icon name={l.icon} size={14} />{l.text}</span>)}</div>}
        {actions && <div style={{ display: "flex", gap: 8 }}>{actions}</div>}
        {foot && <span className="t-small t-muted">{foot}</span>}
      </Card>
    </div>
  );
}
