"use client";
/* Home per role — ported from the prototype shell. Figures are SAMPLE DATA until each slice wires the real
   query (queue → A3, bills → A6, results → A11, beds → B4 …); the API-backed version replaces `sample` field by field. */
import Link from "next/link";
import { Callout, Icon, PageHeader, Panel, Pill, TokenTile, type Tone } from "@setu/ui";
import { format, ROLE_NAME } from "@setu/domain";
import { useSession } from "../../lib/session";
import sample from "../../lib/home-sample.json";
import { OwnerDash } from "../../modules/own/Dash";

type Bi = { bn: string; en: string };
type PillT = { tone: string; label: Bi; icon: string };
interface Home { actions: { icon: string; label: Bi; kbd?: string; mod: string; screen: string; primary: boolean }[]; kpis: { icon: string; label: Bi; value: string; sub: Bi; mod: string; screen: string; tone?: string }[]; listT: Bi; listS: Bi; rows: { a: string; name: Bi; sub: Bi; pill: PillT; mod: string; screen: string }[]; sideT: Bi; side: { icon: string; name: Bi; sub: Bi; pill: PillT; mod: string; screen: string }[]; tip: Bi }
const H = sample as unknown as Record<string, Home>;

export default function HomePage() {
  const s = useSession(); const me = s.me!; const h = H[me.role]; const bn = s.lang === "bn";
  // slice C1–C4: the owner's home is the live dashboard (no sample figures — known gap 5 closed for the owner)
  if (me.role === "owner") return <div className="module-page"><OwnerDash home /></div>;
  const B = (x: Bi) => s.n(bn ? x.bn : x.en);
  const first = (bn ? me.nameBn : me.nameEn).split(" ").slice(-1)[0];
  const today = format.date(new Date(), bn);
  const href = (m: string, k: string) => `/m/${m}/${k}`;
  return (
    <div className="home-page">
      <PageHeader crumbs={today} title={s.t("shellApp", "home_greeting") + first}
        subtitle={`${me.organizationName} · ${bn ? ROLE_NAME[me.role].bn : ROLE_NAME[me.role].en}`}
        actions={h.actions.map((a) => <Link key={a.screen} href={href(a.mod, a.screen)} className={`btn btn-lg${a.primary ? " btn-primary" : ""}`}><Icon name={a.icon} size={16} />{B(a.label)}{a.kbd && <kbd className="kbd">{a.kbd}</kbd>}</Link>)} />
      <div className="ck-stats">
        {h.kpis.map((k) => (
          <Link key={k.label.en} href={href(k.mod, k.screen)} className="ck-stat kpi">
            <span className="ck-stat-label"><Icon name={k.icon} size={15} />{B(k.label)}</span>
            <span className={`ck-stat-value v num${k.tone ? ` ck-tone-${k.tone}` : ""}`}>{s.n(k.value)}</span>
            <span className="ck-stat-note">{B(k.sub)}</span>
          </Link>
        ))}
      </div>
      <div className="home-cols">
        <Panel title={B(h.listT)} note={B(h.listS)} flush>
          {h.rows.map((x, i) => (
            <Link key={i} href={href(x.mod, x.screen)} className="home-row">
              <TokenTile>{s.n(x.a)}</TokenTile>
              <span className="home-row-main"><b>{B(x.name)}</b><span className="num">{B(x.sub)}</span></span>
              <Pill tone={x.pill.tone as Tone} icon={x.pill.icon}>{B(x.pill.label)}</Pill>
              <Icon name="chevron-right" size={16} style={{ color: "var(--text-muted)" }} />
            </Link>
          ))}
        </Panel>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
          <Panel title={B(h.sideT)} flush>
            {h.side.map((x, i) => (
              <Link key={i} href={href(x.mod, x.screen)} className="home-row">
                <span className="home-side-icon"><Icon name={x.icon} size={19} /></span>
                <span className="home-row-main"><b>{B(x.name)}</b><span>{B(x.sub)}</span></span>
                <Pill tone={x.pill.tone as Tone} icon={x.pill.icon}>{B(x.pill.label)}</Pill>
              </Link>
            ))}
          </Panel>
          <Callout icon="keyboard">{B(h.tip)}</Callout>
          <span className="t-small t-muted">{s.t("shellApp", "home_sample_note")}</span>
        </div>
      </div>
    </div>
  );
}
