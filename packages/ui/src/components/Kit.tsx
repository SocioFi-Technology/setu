"use client";
/* The Chartis screen kit (plan 2026-10-13, step 1): the shapes every screen is rebuilt on — page header, toolbar and
   filter chips, list ⇄ detail, panels, stat tiles, key–value grids, tabs, checklists, empty / loading states, the
   sticky action bar, token tiles and the sign-in layout. Styles live in styles/chartis.css (.ck-*). Presentation only:
   every component passes data-* / aria props through so screens keep their test hooks. */
import { useEffect, type HTMLAttributes, type ReactNode } from "react";
import { Icon } from "./Icon";
import { ChartisMark } from "./Brand";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
type Div = Omit<HTMLAttributes<HTMLDivElement>, "title">;

/** Title row of a screen: breadcrumb, title, one line of context, and the screen's actions on the right. */
export function PageHeader({ crumbs, title, subtitle, actions, className, ...rest }: { crumbs?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode } & Div) {
  return (
    <div className={cx("ck-page-head", className)} {...rest}>
      <div className="ck-page-head-text">
        {crumbs && <span className="ck-crumbs">{crumbs}</span>}
        <h1 className="ck-title">{title}</h1>
        {subtitle && <span className="ck-subtitle">{subtitle}</span>}
      </div>
      {actions && <div className="ck-actions">{actions}</div>}
    </div>
  );
}

/** A bar for search and filters above a list. */
export function Toolbar({ children, className, ...rest }: { children: ReactNode } & Div) {
  return <div className={cx("ck-toolbar", className)} {...rest}>{children}</div>;
}

export interface ChipOption<T extends string> { value: T; label: ReactNode; count?: ReactNode }
/** Single-choice filter chips (aria-pressed), with an optional count bubble. */
export function FilterChips<T extends string>({ options, value, onChange, label }: { options: ChipOption<T>[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="ck-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="ck-chip" aria-pressed={o.value === value} onClick={() => onChange(o.value)} data-chip={o.value}>
          {o.label}{o.count != null && <span className="ck-chip-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A list beside its detail; stacks below 1100 px. */
export function SplitView({ list, detail, ratio = "1.15fr 1fr", className, ...rest }: { list: ReactNode; detail: ReactNode; ratio?: string } & Div) {
  return (
    <div className={cx("ck-split", className)} style={{ ["--ck-split" as string]: ratio }} {...rest}>
      <div className="ck-split-list">{list}</div>
      <div className="ck-split-detail">{detail}</div>
    </div>
  );
}

/** A card section with an optional header (title, note, actions) and a footer. `flush` drops the body padding (lists, tables). */
export function Panel({ title, note, actions, foot, flush, children, className, ...rest }: { title?: ReactNode; note?: ReactNode; actions?: ReactNode; foot?: ReactNode; flush?: boolean; children?: ReactNode } & Div) {
  return (
    <section className={cx("ck-panel", className)} {...rest}>
      {(title || actions) && (
        <div className="ck-panel-head">
          <div className="ck-panel-head-text">{title && <h2 className="ck-panel-title">{title}</h2>}{note && <span className="ck-panel-note">{note}</span>}</div>
          {actions && <div className="ck-actions">{actions}</div>}
        </div>
      )}
      <div className={flush ? "ck-panel-flush" : "ck-panel-body"}>{children}</div>
      {foot && <div className="ck-panel-foot">{foot}</div>}
    </section>
  );
}

/** A figure on a home or dashboard: label, value, one line of context. Renders as a link when href is given. */
export function StatTile({ label, value, note, icon, tone, href, as: As = "a", className, ...rest }: { label: ReactNode; value: ReactNode; note?: ReactNode; icon?: string; tone?: "bad" | "warn" | "ok"; href?: string; as?: "a" | "div" } & HTMLAttributes<HTMLElement>) {
  const inner = (<>
    <span className="ck-stat-label">{icon && <Icon name={icon} size={15} />}{label}</span>
    <span className={cx("ck-stat-value num", tone && `ck-tone-${tone}`)}>{value}</span>
    {note && <span className="ck-stat-note">{note}</span>}
  </>);
  if (href) return <a href={href} className={cx("ck-stat", className)} {...rest}>{inner}</a>;
  return As === "div" ? <div className={cx("ck-stat", className)} {...rest}>{inner}</div> : <span className={cx("ck-stat", className)} {...rest}>{inner}</span>;
}

/** Label → value pairs in two columns. */
export function KeyValue({ items, className, ...rest }: { items: { k: ReactNode; v: ReactNode; key?: string }[] } & Div) {
  return (
    <dl className={cx("ck-kv", className)} {...(rest as HTMLAttributes<HTMLElement>)}>
      {items.map((it, i) => <div key={it.key ?? i} className="ck-kv-row"><dt>{it.k}</dt><dd>{it.v}</dd></div>)}
    </dl>
  );
}

export interface TabItem<T extends string> { value: T; label: ReactNode; count?: ReactNode }
/** Underlined tabs (role=tab). */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: TabItem<T>[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="ck-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className="ck-tab" onClick={() => onChange(t.value)}>
          {t.label}{t.count != null && <span className="ck-chip-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** What is done and what is left (admission, discharge, go-live). */
export function Checklist({ items, className, ...rest }: { items: { label: ReactNode; state: "done" | "todo" | "bad"; note?: ReactNode; key?: string }[] } & Div) {
  return (
    <ul className={cx("ck-check", className)} {...(rest as HTMLAttributes<HTMLUListElement>)}>
      {items.map((it, i) => (
        <li key={it.key ?? i} data-state={it.state}>
          <span className="ck-check-dot" aria-hidden="true">{it.state === "done" ? <Icon name="check" size={12} /> : it.state === "bad" ? <Icon name="x" size={12} /> : null}</span>
          <span><span className="ck-check-label">{it.label}</span>{it.note && <span className="ck-check-note">{it.note}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/** Nothing to show: the chart-line mark, a title, one sentence and an action. */
export function EmptyState({ title, body, action, icon, className, ...rest }: { title: ReactNode; body?: ReactNode; action?: ReactNode; icon?: string } & Div) {
  return (
    <div className={cx("ck-empty", className)} {...rest}>
      {icon ? <span className="ck-empty-icon"><Icon name={icon} size={22} /></span>
        : <svg width="56" height="28" viewBox="0 0 48 24" aria-hidden="true"><polyline points="2,12 14,12 19,3 26,21 31,12 46,12" fill="none" stroke="var(--brand-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      <b className="ck-empty-title">{title}</b>
      {body && <span className="ck-empty-body">{body}</span>}
      {action}
    </div>
  );
}

/** Loading rows. */
export function Skeleton({ rows = 5, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="ck-skel" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="ck-skel-row"><span /><span /><span /></div>)}
    </div>
  );
}

/** The save / sign bar that stays at the bottom of a long form. */
export function ActionBar({ note, children, className, ...rest }: { note?: ReactNode; children: ReactNode } & Div) {
  return (
    <div className={cx("ck-actionbar", className)} {...rest}>
      <div className="ck-actionbar-in">{note && <span className="ck-actionbar-note">{note}</span>}<div className="ck-actions">{children}</div></div>
    </div>
  );
}

/** A queue token (A-127) in a tile; `on` is the active one. */
export function TokenTile({ children, on, className, ...rest }: { children: ReactNode; on?: boolean } & HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("ck-token num", on && "on", className)} {...rest}>{children}</span>;
}

/** The sign-in family (login, first sign-in): a pine brand panel beside the form; the panel becomes a band on a phone. */
export function AuthLayout({ product = "Chartis HIS", byline = "by Chartis Health", headline, lead, points, foot, top, children }: {
  product?: string; byline?: string; headline: ReactNode; lead?: ReactNode; points?: { icon: string; title: ReactNode; text: ReactNode }[];
  foot?: ReactNode; top?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="ck-auth">
      <section className="ck-auth-brand" aria-label={product}>
        <svg className="ck-auth-line" aria-hidden="true" viewBox="0 0 1000 420" preserveAspectRatio="none"><polyline points="0,260 260,260 330,260 380,120 450,380 510,200 560,260 1000,260" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="ck-auth-lockup">
          <ChartisMark size={44} tile="var(--pine-800)" />
          <span><b>{product}</b><span>{byline}</span></span>
        </div>
        <div className="ck-auth-pitch">
          <h1 lang="bn">{headline}</h1>
          {lead && <p>{lead}</p>}
          {points && <ul>{points.map((p, i) => <li key={i}><span className="ck-auth-pt-icon"><Icon name={p.icon} size={18} /></span><span><b>{p.title}</b> · {p.text}</span></li>)}</ul>}
        </div>
        {foot && <div className="ck-auth-foot">{foot}</div>}
      </section>
      <section className="ck-auth-form">
        {top && <div className="ck-auth-top">{top}</div>}
        <div className="ck-auth-center">{children}</div>
      </section>
    </div>
  );
}

/** Public pages a QR or a payment returns to (document checks, the bKash result): the Chartis band above a centred column. */
export function PublicFrame({ title = "Chartis Health", note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="ck-public">
      <header className="ck-public-band">
        <span className="ck-public-lockup"><ChartisMark size={32} tile="var(--pine-800)" /><b>{title}</b></span>
        {note && <span className="ck-public-note">{note}</span>}
      </header>
      {children}
    </div>
  );
}

/** A side drawer from the right (previews, documents): the screen stays in view behind it; Esc or the scrim closes it.
   Rendered in place (no portal), like Dialog, so a screen's test hooks around it still find what is inside. */
export function Drawer({ open, onClose, title, label, width = 760, href, hrefLabel = "Open in new tab", foot, children, ...rest }: {
  open: boolean; onClose: () => void; title?: ReactNode; label: string; width?: number; href?: string; hrefLabel?: string; foot?: ReactNode; children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="ck-drawer-scrim" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={label} className="ck-drawer" style={{ width }} onClick={(e) => e.stopPropagation()} {...rest}>
        <header className="ck-drawer-head">
          <b className="ck-drawer-title">{title ?? label}</b>
          {href && <a className="btn btn-sm" href={href} target="_blank" rel="noreferrer" data-testid="drawer-new-tab"><Icon name="external-link" size={14} />{hrefLabel}</a>}
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
        </header>
        <div className="ck-drawer-body">{children}</div>
        {foot && <footer className="ck-drawer-foot">{foot}</footer>}
      </aside>
    </div>
  );
}

/** A document (PDF or HTML preview) filling a drawer's body. */
export function DocFrame({ src, title, ...rest }: { src: string; title: string } & HTMLAttributes<HTMLIFrameElement>) {
  return <iframe className="ck-docframe" src={src} title={title} {...rest} />;
}
