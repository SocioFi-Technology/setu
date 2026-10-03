"use client";
/* Home per role — ported from the prototype shell. Figures are SAMPLE DATA until each slice wires the real
   query (queue → A3, bills → A6, results → A11, beds → B4 …); the API-backed version replaces `sample` field by field. */
import Link from "next/link";
import { Card, CardHead, Callout, Icon, Pill, type Tone } from "@setu/ui";
import { format, ROLE_NAME } from "@setu/domain";
import { useSession } from "../../lib/session";
import sample from "../../lib/home-sample.json";
import { OwnerDash } from "../../modules/own/Dash";

type Bi = { bn: string; en: string };
type PillT = { tone: string; label: Bi; icon: string };
interface Home { actions: { icon: string; label: Bi; kbd?: string; mod: string; screen: string; primary: boolean }[]; kpis: { icon: string; label: Bi; value: string; sub: Bi; mod: string; screen: string; tone?: string }[]; listT: Bi; listS: Bi; rows: { a: string; name: Bi; sub: Bi; pill: PillT; mod: string; screen: string }[]; sideT: Bi; side: { icon: string; name: Bi; sub: Bi; pill: PillT; mod: string; screen: string }[]; tip: Bi }
const H = sample as unknown as Record<string, Home>;
const toneFg: Record<string, string> = { bad: "var(--danger-fg)", warn: "var(--warning-fg)", ok: "var(--success-fg)" };

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
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="t-muted" style={{ font: "500 13px/20px var(--font-sans)" }}>{today}</span>
          <h1 className="t-title">{s.L("শুভ সকাল, ", "Good morning, ") + first}</h1>
          <span className="t-body t-secondary">{me.organizationName} · {bn ? ROLE_NAME[me.role].bn : ROLE_NAME[me.role].en}</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {h.actions.map((a) => <Link key={a.screen} href={href(a.mod, a.screen)} className={`btn btn-lg${a.primary ? " btn-primary" : ""}`}><Icon name={a.icon} size={16} />{B(a.label)}{a.kbd && <kbd className="kbd">{a.kbd}</kbd>}</Link>)}
        </div>
      </div>
      <div className="kpi-grid">
        {h.kpis.map((k) => (
          <Link key={k.label.en} href={href(k.mod, k.screen)} className="card kpi">
            <span className="t-muted" style={{ display: "flex", alignItems: "center", gap: 6, font: "500 12px/18px var(--font-sans)" }}><Icon name={k.icon} size={14} />{B(k.label)}</span>
            <span className="v" style={{ color: k.tone ? toneFg[k.tone] : undefined }}>{s.n(k.value)}</span>
            <span className="t-small t-muted">{B(k.sub)}</span>
          </Link>
        ))}
      </div>
      <div className="home-grid">
        <Card style={{ overflow: "hidden" }}>
          <CardHead title={B(h.listT)} subtitle={B(h.listS)} />
          {h.rows.map((x, i) => (
            <Link key={i} href={href(x.mod, x.screen)} className="row-btn" style={{ textDecoration: "none" }}>
              <span className="num" style={{ width: 56, font: "600 13px/20px var(--font-mono)", color: "var(--text-secondary)" }}>{s.n(x.a)}</span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}><span style={{ font: "600 14px/22px var(--font-sans)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{B(x.name)}</span><span className="t-small t-muted num" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{B(x.sub)}</span></span>
              <Pill tone={x.pill.tone as Tone} icon={x.pill.icon}>{B(x.pill.label)}</Pill>
              <Icon name="chevron-right" size={16} style={{ color: "var(--text-muted)" }} />
            </Link>
          ))}
        </Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card style={{ overflow: "hidden" }}>
            <CardHead title={B(h.sideT)} />
            {h.side.map((x, i) => (
              <Link key={i} href={href(x.mod, x.screen)} className="row-btn" style={{ textDecoration: "none" }}>
                <Icon name={x.icon} size={18} style={{ color: "var(--text-muted)" }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}><span style={{ font: "600 14px/22px var(--font-sans)" }}>{B(x.name)}</span><span className="t-small t-muted">{B(x.sub)}</span></span>
                <Pill tone={x.pill.tone as Tone} icon={x.pill.icon}>{B(x.pill.label)}</Pill>
              </Link>
            ))}
          </Card>
          <Callout icon="keyboard">{B(h.tip)}</Callout>
          <span className="t-small t-muted">{s.L("নমুনা সংখ্যা — প্রতিটি স্লাইস বাস্তব ডেটা যুক্ত করবে", "Sample figures — each slice replaces them with live data")}</span>
        </div>
      </div>
    </div>
  );
}
