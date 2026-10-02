/* Strings exported from the design (docs/design-handoff/i18n). Namespaced by page/module.
   Bangla is the default; `t` falls back to English, then to the key, and never throws. */
import bn from "../locales/bn.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

export type Lang = "bn" | "en";
import frontDeskApp from "../locales/app/frontDeskApp.json" with { type: "json" };
type Table = Record<string, Record<string, string>>;
const tables: Record<Lang, Table> = { bn: { ...(bn as Table) }, en: { ...(en as Table) } };

/* App strings the design export does not carry, kept as [bn, en] pairs per key (one file per namespace). */
const APP: Record<string, Record<string, [string, string]>> = { frontDeskApp: frontDeskApp as unknown as Record<string, [string, string]> };
for (const [n, pairs] of Object.entries(APP)) {
  tables.bn[n] = Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v[0]]));
  tables.en[n] = Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v[1]]));
}

export const NAMESPACES = Object.keys(tables.bn);

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

/** `{name}` placeholders → values (numbers are passed already formatted for the chosen numerals). */
export const fill = (s: string, vars: Record<string, string | number> = {}) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
