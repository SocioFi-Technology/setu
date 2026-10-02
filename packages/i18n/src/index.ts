/* Strings exported from the design (docs/design-handoff/i18n). Namespaced by page/module.
   Bangla is the default; `t` falls back to English, then to the key, and never throws. */
import bn from "../locales/bn.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

export type Lang = "bn" | "en";
type Table = Record<string, Record<string, string>>;
const tables: Record<Lang, Table> = { bn: bn as Table, en: en as Table };

export const NAMESPACES = Object.keys(bn) as (keyof typeof bn)[];

export function t(lang: Lang, ns: string, key: string): string {
  return tables[lang][ns]?.[key] ?? tables.en[ns]?.[key] ?? tables.bn[ns]?.[key] ?? key;
}
/** Bound translator for one namespace: const T = ns("front_desk"); T("bn","register"). */
export const ns = (namespace: string) => (lang: Lang, key: string) => t(lang, namespace, key);
/** Keys present in Bangla but missing in English — must be empty before a release. */
export function missingEnglish(): string[] {
  const out: string[] = [];
  for (const n of Object.keys(tables.bn)) for (const k of Object.keys(tables.bn[n] ?? {})) if (!tables.en[n]?.[k]) out.push(`${n}.${k}`);
  return out;
}
