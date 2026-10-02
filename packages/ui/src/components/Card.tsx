import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";
export function Card({ children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return <div className={["card", className].filter(Boolean).join(" ")} {...rest}>{children}</div>;
}
export function CardHead({ title, subtitle, right }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="card-head">
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <b className="t-h3">{title}</b>
        {subtitle && <span className="t-small t-muted">{subtitle}</span>}
      </div>
      {right}
    </div>
  );
}
export function Callout({ icon = "info", tone = "info", children }: { icon?: string; tone?: "info" | "warn"; children: ReactNode }) {
  return <div className={`callout${tone === "warn" ? " callout-warn" : ""}`}><Icon name={icon} size={16} style={{ marginTop: 2 }} /><span>{children}</span></div>;
}
