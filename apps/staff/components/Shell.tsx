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
  const { L, lang, n } = s;
  const bn = lang === "bn";
  const curMod = path.startsWith("/m/") ? path.split("/")[2] : null;

  const t = {
    search: L("রোগী খুঁজুন", "Find patient"), searchPh: L("নাম, ফোন, রোগী নং বা QR · F2", "Name, phone, patient no. or QR · F2"),
    palette: L("কমান্ড", "Command palette"), palPh: L("মডিউল বা স্ক্রিন খুঁজুন…", "Go to a module or screen…"), palNone: L("কিছু মেলেনি", "Nothing matches"),
    scan: L("QR স্ক্যান", "Scan QR"), patients: L("রোগী", "Patients"), noMatch: L("মিল নেই — নতুন নিবন্ধন করুন", "No match — register a new patient"),
    offline: L("অফলাইন", "Offline"), synced: L("সিঙ্ক", "Synced"), notifs: L("বিজ্ঞপ্তি", "Notifications"), nav: L("প্রধান মেনু", "Main navigation"), home: L("হোম", "Home"),
    offlineBanner: L("অফলাইন — কাজ চলবে, এই ডিভাইসে সংরক্ষিত হবে। স্বাক্ষর, SMS ও পেমেন্ট সার্ভার ফিরলে যাবে; ততক্ষণ কিছুই “পাঠানো” বা “স্বাক্ষরিত” দেখাবে না।", "Offline — you can keep working; changes are saved on this device. Signing, SMS and payments send when the server is back; nothing shows as Sent or Signed until then."),
    queued: (k: number) => L(`${k}টি পরিবর্তন অপেক্ষমাণ`, `${k} changes queued`), ctxNote: L("রোগী প্রসঙ্গ · সব মডিউলে একই ব্যানার", "Patient context · same banner in every module"),
    logout: L("লগআউট", "Sign out"),
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
  const hiddenNote = hiddenByPlan.length ? L(`${n(hiddenByPlan.length)}টি মডিউল এই প্ল্যানে নেই — ক্লিক করে দেখুন`, `${hiddenByPlan.length} module(s) not in this plan — click to see`)
    : otLocked ? L("OT ও রেডিওলজি Hospital Pro-তে", "OT needs Hospital Pro") : lockedScreens ? L("কিছু স্ক্রিন Hospital Pro-তে", "Some screens need Hospital Pro") : L("সব মডিউল চালু", "All modules available");

  const palItems = useMemo(() => {
    const items = [{ l: t.home, sub: t.home, icon: "house", href: "/", key: "home" }, ...mods.flatMap((m) => m.screens.map((x) => ({
      l: bn ? x.name_bn : x.name_en, sub: (bn ? m.name_bn : m.name_en) + (x.allowed ? "" : " · " + L("প্ল্যানে নেই", "not in plan")), icon: x.allowed ? x.icon : "lock",
      href: `/m/${m.key}/${x.key}`, key: (x.name_bn + " " + x.name_en + " " + m.name_bn + " " + m.name_en).toLowerCase(),
    })))];
    const pq = palQ.trim().toLowerCase();
    return items.filter((p) => !pq || p.key.includes(pq)).slice(0, 12);
  }, [mods, palQ, bn, L, t.home]);
  const psel = Math.min(palSel, Math.max(0, palItems.length - 1));
  const go = (href: string) => { setPal(false); setSearchOpen(false); router.push(href); };

  const me = s.me;
  const roleName = me ? (bn ? ROLE_NAME[me.role].bn : ROLE_NAME[me.role].en) : "";
  const meName = me ? (bn ? me.nameBn : me.nameEn) : "";

  return (
    <div className="shell">
      <header className="shell-top">
        <span className="shell-brand">Setu</span>
        <button type="button" className="org-btn" title={L("প্রতিষ্ঠান ও শাখা", "Organisations & branches")}>
          <Icon name="building-2" size={16} />
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}><b>{me?.organizationName ?? "—"}</b><span>{L("শাখা বদলালে অ্যাক্সেস বদলায়", "access changes with the branch")}</span></span>
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
              <div className="t-muted" style={{ padding: 10, font: "500 13px/20px var(--font-sans)" }}>{q.trim() ? t.noMatch : L("ফোন নম্বর বা নাম লিখুন", "Type a phone number or a name")} <span className="t-small">· {L("(রোগী খোঁজা স্লাইস A1-এ আসছে)", "(search arrives in slice A1)")}</span></div>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="unsent-drafts">
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
