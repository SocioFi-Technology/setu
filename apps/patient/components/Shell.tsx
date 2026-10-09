"use client";
/* The signed-in frame: the app name, the language switch and sign-out on top; History and Find records at the bottom. */
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@setu/ui";
import { BASE, patient } from "../lib/api";
import { forgetAll } from "../lib/cache";
import { useLang } from "../lib/lang";

export function Shell({ children }: { children: ReactNode }) {
  const { lang, setLang, T } = useLang();
  const path = usePathname();
  const signOut = async () => { forgetAll(); try { await patient.signOut(); } catch {} location.href = BASE + "/welcome"; };
  const tab = (href: string, icon: string, key: string) => (
    <Link href={href} aria-current={path === href ? "page" : undefined}><Icon name={icon} size={22} />{T(key)}</Link>
  );
  return (
    <div className="pa">
      <StagingBanner />
      <header className="pa-top">
        <b>{T("app_name")}</b>
        <button type="button" className="pa-btn pa-btn-link" onClick={() => setLang(lang === "bn" ? "en" : "bn")} aria-label="ভাষা · Language">{lang === "bn" ? "English" : "বাংলা"}</button>
        <button type="button" className="pa-btn pa-btn-link" onClick={signOut}><Icon name="log-out" size={18} />{T("sign_out")}</button>
      </header>
      <main className="pa-main">{children}</main>
      <nav className="pa-tabs">{tab("/timeline", "history", "tab_history")}{tab("/share", "share-2", "tab_share")}{tab("/claim", "search", "tab_claims")}</nav>
    </div>
  );
}

/** ADR 0021 (Kamrul 09/10/2026): the staging build says so on every screen — a tester never mistakes it for the real app */
export function StagingBanner() {
  const { T } = useLang();
  if (process.env.NEXT_PUBLIC_SETU_STAGE !== "staging") return null;
  return <div role="note" className="pa-staging">{T("staging_banner")}</div>;
}
