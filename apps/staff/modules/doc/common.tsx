"use client";
/* Doctor app (slice A12–A13, prototype Setu Doctor App · 412): one phone column with a bottom tab bar (home, queue,
   reports). It lives inside the staff shell (runbook: "the Doctor App layout inside apps/staff at phone width"); the
   native app with its own offline store comes later (screens.md, Flutter). */
import type { ReactNode } from "react";
import Link from "next/link";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Callout, Icon } from "@setu/ui";
import { useSession } from "../../lib/session";

/** Doctor-app strings: `D("key", { n })` from the doctorApp namespace; numbers follow the numerals toggle. */
export function useD() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("doctorApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function useDF() {
  const s = useSession(); const bn = s.numerals === "bn";
  return {
    name: (p: { nameBn: string; nameEn: string | null } | null | undefined) => (p ? (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn) : "—"),
    time: (iso: string) => format.time(iso, bn),
    dateTime: (iso: string) => format.dateTime(iso, bn),
    date: (iso: string | Date) => format.date(iso, bn),
    num: (n: number | string) => format.digits(n, bn),
  };
}
export const docUrl = (screen: "home" | "queue" | "consult" | "inbox", enc?: string) => `/m/doc/${screen}${enc ? `?enc=${encodeURIComponent(enc)}` : ""}`;

/** The last unread count the inbox reported (the badge on the Reports tab; known once home or the inbox has loaded). */
let lastUnread: number | null = null;
export const rememberUnread = (n: number) => { lastUnread = n; };

const TABS = [
  { key: "home", icon: "house", label: "tab_home" },
  { key: "queue", icon: "ticket", label: "tab_queue" },
  { key: "inbox", icon: "file-text", label: "tab_inbox" },
] as const;

export function DocFrame({ tab, children }: { tab: "home" | "queue" | "consult" | "inbox"; children: ReactNode }) {
  const s = useSession(); const D = useD();
  return (
    <div className="doc-frame" data-doc-screen={tab}>
      {!s.online && <Callout tone="warn" icon="cloud-off" data-testid="doc-offline">{D("offline")}</Callout>}
      {children}
      <div className="doc-tabs">
        <nav aria-label={D("nav_label")}>
          {TABS.map((t) => (
            <Link key={t.key} href={docUrl(t.key)} className="doc-tab" aria-current={tab === t.key || (tab === "consult" && t.key === "queue") ? "page" : undefined} data-tab={t.key}>
              <Icon name={t.icon} size={20} />
              <span>{D(t.label)}</span>
              {t.key === "inbox" && lastUnread ? <span className="badge-count num" data-testid="inbox-badge">{s.n(lastUnread)}</span> : null}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
