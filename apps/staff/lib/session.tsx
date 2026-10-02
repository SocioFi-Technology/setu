"use client";
/* Session + UI preferences for the shell. Access decisions come from the API's capabilities, never from here. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Capabilities, Me } from "@setu/contracts";
import { format } from "@setu/domain";
import { t as tr } from "@setu/i18n";
import type { BannerPatient } from "@setu/ui";
import { api } from "./api";
import { onOutbox, pendingCount, setOutboxOwner } from "./outbox";

export type Lang = "bn" | "en";
export type Numerals = "bn" | "en";
interface Session {
  me: Me | null; caps: Capabilities | null; loading: boolean;
  lang: Lang; setLang: (l: Lang) => void;
  numerals: Numerals; setNumerals: (n: Numerals) => void;
  online: boolean; queued: number;
  patient: BannerPatient | null; setPatient: (p: BannerPatient | null) => void;
  L: (bn: string, en: string) => string;
  /** digits in the chosen numerals (never applied to identifiers like GLC-240117 or INV/25/0938) */
  n: (v: string | number) => string;
  t: (ns: string, key: string) => string;
  refresh: () => Promise<void>; logout: () => Promise<void>;
}
const Ctx = createContext<Session>(null as unknown as Session);
const read = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };

/** Converts digits inside free text, but leaves tokens that look like identifiers alone (prototype rule). */
export function convertDigits(v: string | number, bn: boolean): string {
  const s = String(v);
  if (!bn) return format.toEn(s);
  return s.replace(/[0-9](?:[0-9,.:\/]*[0-9])?/g, (m, off: number, str: string) => {
    const pre = str.slice(Math.max(0, off - 2), off), post = str.slice(off + m.length, off + m.length + 3);
    if (/[A-Za-z]$/.test(pre) || /^[A-Za-z]/.test(post)) return m;
    const tokS = str.lastIndexOf(" ", off - 1) + 1, sp = str.indexOf(" ", off + m.length), tok = str.slice(tokS, sp < 0 ? str.length : sp);
    if (/[A-Za-z]/.test(tok) && /[-\/]/.test(tok)) return m;
    return format.toBn(m);
  });
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [lang, setLangS] = useState<Lang>("bn");
  const [numerals, setNumS] = useState<Numerals>("bn");
  const [online, setOnline] = useState(true);
  const [patient, setPatient] = useState<BannerPatient | null>(null);
  const [queued, setQueued] = useState(0);
  useEffect(() => { setQueued(pendingCount()); return onOutbox(setQueued); }, []);
  // The outbox only replays writes made by the signed-in user at this tenant and facility.
  useEffect(() => { setOutboxOwner(me ? { userId: me.userId, tenantId: me.tenantId, organizationId: me.organizationId } : null); setQueued(pendingCount()); }, [me?.userId, me?.tenantId, me?.organizationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = useCallback(async () => {
    try { const [m, c] = await Promise.all([api.me(), api.capabilities()]); setMe(m); setCaps(c); }
    catch { setMe(null); setCaps(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { setLangS(read("setu.lang", "bn") as Lang); setNumS(read("setu.num", "bn") as Numerals); if (location.pathname === "/login") setLoading(false); else void refresh(); }, [refresh]);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    setOnline(navigator.onLine); window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const value = useMemo<Session>(() => ({
    me, caps, loading, lang, numerals, online, queued, patient, setPatient,
    setLang: (l) => { setLangS(l); try { localStorage.setItem("setu.lang", l); } catch {} },
    setNumerals: (v) => { setNumS(v); try { localStorage.setItem("setu.num", v); } catch {} },
    L: (bn, en) => (lang === "bn" ? bn : en),
    n: (v) => convertDigits(v, numerals === "bn"),
    t: (ns, key) => tr(lang, ns, key),
    refresh,
    logout: async () => { setOutboxOwner(null); await api.logout(); setMe(null); setCaps(null); location.href = "/login"; },
  }), [me, caps, loading, lang, numerals, online, queued, patient, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);
