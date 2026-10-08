"use client";
/* Staff App shell — ported from docs/prototype/Setu Staff App.dc.html.
   Top bar (56 px): org + branch, global search (F2, /), command palette (Ctrl/⌘+K), sync state, language and numerals toggles, notifications, user.
   Left nav (232 px): modules filtered by role, plan-locked items stay visible with a lock (from GET /me/capabilities).
   Patient banner slot under the top bar; offline banner; the page states live in ../app/(shell)/m. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { CapabilityModule } from "@setu/contracts";
import { PLAN_NAME, PLAN_RANK, ROLE_NAME, type Plan } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Dialog, Icon, IconButton, OfflineBanner, PatientHeaderBanner, Segmented } from "@setu/ui";
import { deviceDraftCount } from "../lib/outbox";
import { useSession } from "../lib/session";
import { RefusedSync } from "./RefusedSync";

const initials = (name: string) => name.replace(/^(ডা\.|Dr\.)\s*/, "").trim().slice(0, 2);

export function Shell({ children }: { children: ReactNode }) {
  const s = useSession(); const path = usePathname(); const router = useRouter();
  const [pal, setPal] = useState(false); const [palQ, setPalQ] = useState(""); const [palSel, setPalSel] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false); const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [unsent, setUnsent] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null); const palRef = useRef<HTMLInputElement>(null);
  const { lang, n } = s;
  const bn = lang === "bn";
  const curMod = path.startsWith("/m/") ? path.split("/")[2] : null;

  /** shellApp strings; vars are passed as given (the queued count stays in Western digits, as before). */
  const S = (key: string, vars: Record<string, string | number> = {}) => fill(s.t("shellApp", key), vars);
  const t = {
    search: S("shell_search"), searchPh: S("shell_search_ph"),
    palette: S("shell_palette"), palPh: S("shell_palette_ph"), palNone: S("shell_palette_none"),
    scan: S("shell_scan"), patients: S("shell_patients"), noMatch: S("shell_no_match"),
    offline: S("shell_offline"), synced: S("shell_synced"), notifs: S("shell_notifs"), nav: S("shell_nav"), home: S("shell_home"),
    offlineBanner: S("shell_offline_banner"),
    queued: (k: number) => S("shell_queued", { n: k }), ctxNote: S("shell_ctx_note"),
    logout: S("shell_logout"),
  };

  // keyboard: Ctrl/⌘+K palette · F2 search · '/' search (except inside Consultation, where it is the Rx search — round-2 fix #9)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tg = (e.target as HTMLElement)?.tagName, inField = tg === "INPUT" || tg === "TEXTAREA" || tg === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPal(true); setPalQ(""); setPalSel(0); setSearchOpen(false); return; }
      if (e.key === "F2") { e.preventDefault(); setPal(false); setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 30); return; }
      if (e.key === "Escape") { setSearchOpen(false); return; }
      if (e.key === "/" && !inField && curMod !== "cons") { e.preventDefault(); setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 30); }
    };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  }, [curMod]);

  const mods: CapabilityModule[] = s.caps?.modules ?? [];
  const plan = (s.me?.plan ?? "clinic") as Plan;
  const hiddenByPlan = mods.filter((m) => m.locked === "plan");
  const lockedScreens = mods.some((m) => !m.locked && m.screens.some((x) => x.reason === "plan"));
  const otLocked = mods.some((m) => m.key === "er" && !m.locked && PLAN_RANK[plan] < 2);
  const hiddenNote = hiddenByPlan.length ? S("shell_hidden_by_plan", { n: bn ? n(hiddenByPlan.length) : hiddenByPlan.length })
    : otLocked ? S("shell_ot_locked") : lockedScreens ? S("shell_screens_locked") : S("shell_all_modules");

  const notInPlan = S("shell_not_in_plan");
  const palItems = useMemo(() => {
    const items = [{ l: t.home, sub: t.home, icon: "house", href: "/", key: "home" }, ...mods.flatMap((m) => m.screens.map((x) => ({
      l: bn ? x.name_bn : x.name_en, sub: (bn ? m.name_bn : m.name_en) + (x.allowed ? "" : " · " + notInPlan), icon: x.allowed ? x.icon : "lock",
      href: `/m/${m.key}/${x.key}`, key: (x.name_bn + " " + x.name_en + " " + m.name_bn + " " + m.name_en).toLowerCase(),
    })))];
    const pq = palQ.trim().toLowerCase();
    return items.filter((p) => !pq || p.key.includes(pq)).slice(0, 12);
  }, [mods, palQ, bn, notInPlan, t.home]);
  const psel = Math.min(palSel, Math.max(0, palItems.length - 1));
  const go = (href: string) => { setPal(false); setSearchOpen(false); router.push(href); };

  const me = s.me;
  const roleName = me ? (bn ? ROLE_NAME[me.role].bn : ROLE_NAME[me.role].en) : "";
  const meName = me ? (bn ? me.nameBn : me.nameEn) : "";

  return (
    <div className="shell">
      <header className="shell-top">
        <span className="shell-brand">Setu</span>
        <button type="button" className="org-btn" title={S("shell_org_branches")}>
          <Icon name="building-2" size={16} />
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}><b>{me?.organizationName ?? "—"}</b><span>{S("shell_org_branch_note")}</span></span>
          <Icon name="chevrons-up-down" size={14} />
        </button>
        <div className="search" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSearchOpen(false); }}>
          <Icon name="search" size={16} style={{ color: "var(--text-muted)" }} />
          <input ref={searchRef} data-global-search="1" aria-label={t.search} placeholder={t.searchPh} value={q} onChange={(e) => { setQ(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} />
          <kbd className="kbd">F2</kbd>
          <button type="button" className="btn-icon" style={{ width: 28, height: 28 }} aria-label={t.scan} title={t.scan}><Icon name="scan-line" size={16} /></button>
          {searchOpen && (
            <div className="popover" role="listbox" aria-label={t.patients}>
              <div className="t-label" style={{ padding: "6px 10px" }}>{t.patients}</div>
              <div className="t-muted" style={{ padding: 10, font: "500 13px/20px var(--font-sans)" }}>{q.trim() ? t.noMatch : S("shell_search_hint")} <span className="t-small">· {S("shell_search_soon")}</span></div>
            </div>
          )}
        </div>
        <button type="button" className="btn btn-sm" style={{ height: 40, color: "var(--text-secondary)" }} aria-label={t.palette} title={t.palette + " · Ctrl+K"} onClick={() => { setPal(true); setPalQ(""); setPalSel(0); }}>
          <Icon name="command" size={15} /><kbd className="kbd palette-kbd">Ctrl K</kbd>
        </button>
        <span style={{ marginLeft: "auto" }} />
        <span role="status" className={`sync-pill${s.online ? "" : " off"}`}><Icon name={s.online ? "check-check" : "wifi-off"} size={14} />{s.online ? t.synced : t.offline}</span>
        <RefusedSync />
        <Segmented value={lang} onChange={s.setLang} options={[{ value: "bn", label: "বাং" }, { value: "en", label: "EN" }]} label="Language" />
        <Segmented value={s.numerals} onChange={s.setNumerals} options={[{ value: "bn", label: "০১২৩" }, { value: "en", label: "0123" }]} label="Numerals" rawDigits />
        <IconButton icon="bell" label={t.notifs} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 44, padding: "0 8px 0 4px" }}>
          <span className="avatar avatar-brand" style={{ width: 34, height: 34, font: "600 13px/18px var(--font-sans)" }}>{initials(meName)}</span>
          <span className="shell-me-text">
            <span style={{ font: "600 13px/16px var(--font-sans)", whiteSpace: "nowrap" }}>{meName}</span>
            <span className="t-muted" style={{ font: "400 11px/14px var(--font-sans)", whiteSpace: "nowrap" }}>{roleName}</span>
          </span>
          <IconButton icon="log-out" label={t.logout} onClick={() => void s.logout().then((done) => { if (!done) setUnsent(true); })} />
        </div>
      </header>

      {/* Clinical review A5: unsent note drafts are never deleted at sign-out without asking. */}
      <Dialog open={unsent} onClose={() => setUnsent(false)} label={s.t("shellApp", "unsent_title")} width={480}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="unsent-drafts">
          <b className="t-h3">{s.t("shellApp", "unsent_title")}</b>
          <span>{s.t("shellApp", "unsent_body").replace("{n}", s.n(deviceDraftCount()))}</span>
          <span style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={() => setUnsent(false)}>{s.t("shellApp", "unsent_stay")}</button>
            <button type="button" className="btn btn-danger" onClick={() => void s.logout(true)}>{s.t("shellApp", "unsent_signout")}</button>
          </span>
        </div>
      </Dialog>

      <Dialog open={pal} onClose={() => setPal(false)} label={t.palette}>
        <div className="dialog-head">
          <Icon name="command" size={17} style={{ color: "var(--text-muted)" }} />
          <input ref={palRef} autoFocus data-palette="1" aria-label={t.palette} placeholder={t.palPh} value={palQ} onChange={(e) => { setPalQ(e.target.value); setPalSel(0); }}
            onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setPalSel(Math.min(psel + 1, palItems.length - 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setPalSel(Math.max(psel - 1, 0)); } else if (e.key === "Enter" && palItems[psel]) { e.preventDefault(); go(palItems[psel].href); } }} />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div role="listbox" style={{ maxHeight: 420, overflow: "auto", padding: 6, display: "flex", flexDirection: "column" }}>
          {palItems.map((p, i) => (
            <button key={p.href} type="button" role="option" aria-selected={i === psel} className="option" style={{ minHeight: 40 }} onClick={() => go(p.href)}>
              <Icon name={p.icon} size={16} />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}><span style={{ font: "600 13px/18px var(--font-sans)" }}>{p.l}</span><span className="t-muted" style={{ font: "400 11px/16px var(--font-sans)" }}>{p.sub}</span></span>
            </button>
          ))}
          {palItems.length === 0 && <div className="t-muted" style={{ padding: "12px 10px", font: "500 13px/20px var(--font-sans)" }}>{t.palNone}</div>}
        </div>
      </Dialog>

      {!s.online && <OfflineBanner text={t.offlineBanner} queued={t.queued(s.queued)} />}

      <div className="shell-body">
        <nav aria-label={t.nav} className="shell-nav">
          <div className="nav-list">
            <Link href="/" className="nav-item home" aria-current={path === "/" ? "page" : undefined}><Icon name="house" size={18} /><span className="lbl">{t.home}</span></Link>
            {mods.map((m) => {
              const locked = m.locked === "plan", open = !closed[m.key] && !locked;
              return (
                <div key={m.key}>
                  <button type="button" className="nav-group" aria-expanded={open} onClick={() => setClosed((c) => ({ ...c, [m.key]: !c[m.key] }))}>
                    <span><Icon name={m.icon} size={14} />{bn ? m.name_bn : m.name_en}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {locked && <span className="lock-tag"><Icon name="lock" size={10} />{PLAN_NAME[m.plan].replace("Hospital ", "")}</span>}
                      <Icon name={locked ? "lock" : open ? "chevron-down" : "chevron-right"} size={13} />
                    </span>
                  </button>
                  {(open || locked) && m.screens.map((x) => {
                    const href = `/m/${m.key}/${x.key}`, lk = x.reason === "plan";
                    return (
                      <Link key={x.key} href={href} className={`nav-item${lk ? " locked" : ""}`} aria-current={path === href ? "page" : undefined} title={x.name_en + (lk && x.needs ? " · " + PLAN_NAME[x.needs] : "")}>
                        <Icon name={lk ? "lock" : x.icon} size={16} />
                        <span className="lbl">{bn ? x.name_bn : x.name_en}</span>
                        {x.badge && !lk && <span className="badge-count num">{n(x.badge)}</span>}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="nav-foot">
            <span className="plan-tag"><Icon name="package-check" size={12} />{PLAN_NAME[plan]}</span>
            <span className="t-small t-muted">{hiddenNote}</span>
          </div>
        </nav>
        <div className="shell-main">
          {s.patient && <PatientHeaderBanner p={s.patient} lang={lang} note={t.ctxNote} />}
          <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>{children}</main>
        </div>
      </div>
    </div>
  );
}
