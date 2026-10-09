"use client";
/* The patient's language: Bangla first; chosen on the welcome screen and kept on this phone. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fill, t, type Lang } from "@setu/i18n";
import { format } from "@setu/domain";

const KEY = "setu_patient_lang";
interface Ctx { lang: Lang; setLang: (l: Lang) => void; T: (key: string, vars?: Record<string, string | number>) => string; n: (s: string | number) => string }
const LangContext = createContext<Ctx | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<Lang>("bn");
  useEffect(() => { try { const v = localStorage.getItem(KEY); if (v === "en" || v === "bn") set(v); } catch {} }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l: Lang) => { set(l); try { localStorage.setItem(KEY, l); } catch {} }, []);
  const n = useCallback((s: string | number) => format.digits(s, lang === "bn"), [lang]);
  const T = useCallback((key: string, vars?: Record<string, string | number>) => fill(t(lang, "patientApp", key), vars), [lang]);
  return <LangContext.Provider value={{ lang, setLang, T, n }}>{children}</LangContext.Provider>;
}
export function useLang(): Ctx {
  const c = useContext(LangContext);
  if (!c) throw new Error("useLang outside LangProvider");
  return c;
}
/** "2026-08" → "আগস্ট ২০২৬" / "August 2026" */
export function monthLabel(ym: string, T: Ctx["T"], n: Ctx["n"]): string {
  const [y, m] = ym.split("-");
  return `${T("m" + m)} ${n(y ?? "")}`;
}
/** the message of an API error in the chosen language */
export const errText = (lang: Lang, e: unknown, T: Ctx["T"]): string => {
  const b = (e as { body?: { message_bn?: string; message_en?: string } }).body;
  return (lang === "bn" ? b?.message_bn : b?.message_en) ?? T("err_server");
};
