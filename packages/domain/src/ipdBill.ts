/* The IPD running bill (ADR 0017, walkthrough B8). The bill is rebuilt from its sources — the package, bed days, orders
   on the inpatient visit, ward stock drawn for the patient, charges posted by hand — by `desiredLines`; the API
   reconciles the posted lines to it (`reconcileLines`): a changed line is superseded by a new one, a line no longer
   wanted gets a credit line, nothing is edited or deleted. Kamrul's decisions of 06/10/2026:
   - Bed days: midnight census, the admission day is day 1 (posted at admit), day n at 00:01 Dhaka of admit day + n − 1.
   - A bed day is priced at the highest-rate class occupied during that Dhaka day: moving up re-prices today, moving
     down applies from tomorrow (costs the patient nothing on the day of the move).
   - The package is priced at the highest class occupied during the stay so far (snapshot prices, fixed when applied).
   - Deposits are payments on the draft IPD bill; low = under two days of the current class's rate, due = negative. */
import { dhakaDay } from "./queue.js";
import { MAX_PAISA, vatOn, type Paisa } from "./money.js";

export type IpdTag = "package" | "included" | "excluded";
export type IpdSource = "package" | "bed-day" | "order" | "stock" | "desk";

/** The package as the admission keeps it (copied when applied: a later catalogue change never re-prices a patient). */
export interface PackageSnapshot {
  packageId: string; code: string; nameEn: string; nameBn: string;
  /** bed days included */ days: number;
  /** package price per bed class, paisa */ prices: Record<string, Paisa>;
  /** included services by charge code (e.g. test:cbc), with a limit (null = any number) */ services: { code: string; limit: number | null }[];
  /** included medicines by key (the package's medicine list) */ medicines: string[];
  /** shown on the bill as "not in the package" (text only) */ excluded: { nameEn: string; nameBn: string }[];
}
export interface ClassRate { perDayPaisa: Paisa; nameEn: string; nameBn: string }
/** One stay in a bed class: from arrival to leaving it (null = still there). */
export interface ClassLeg { bedClass: string; from: Date; to: Date | null }
export interface OrderFact { id: string; code: string; nameEn: string; nameBn: string; unitPaisa: Paisa | null; vatRateBp: number; at: Date }
/** Ward stock drawn for the patient, net of units put back, per source record and batch. */
export interface StockFact { key: string; refId: string; batchId: string; medicineKey: string; nameEn: string; nameBn: string; units: number; unitPaisa: Paisa; vatRateBp: number; at: Date }
export interface ManualFact { id: string; code: string; nameEn: string; nameBn: string; unitPaisa: Paisa; vatRateBp: number; qty: number; at: Date }
export interface StayFacts {
  admitAt: Date; releasedAt: Date | null; legs: ClassLeg[]; rates: Record<string, ClassRate>;
  pkg: PackageSnapshot | null; orders: OrderFact[]; stock: StockFact[]; manual: ManualFact[];
}
export interface DesiredLine {
  key: string; source: IpdSource; tag: IpdTag; code: string; nameEn: string; nameBn: string;
  unitPaisa: Paisa | null; qty: number; vatRateBp: number;
  sourceId: string | null; batchId: string | null; medicineKey: string | null;
  /** bed days: the Dhaka day, its number and the class it is priced at */ serviceDay: string | null; dayNo: number | null; bedClass: string | null;
}

const DAY = 86_400_000;
/** Dhaka midnight (00:00 +06:00) of a YYYY-MM-DD day, as an instant. */
export const dhakaMidnight = (day: string) => new Date(`${day}T00:00:00+06:00`);
export const addDays = (day: string, n: number) => dhakaDay(new Date(dhakaMidnight(day).getTime() + n * DAY));
/** Bed days due by `now`: day 1 from admission, day n once 00:01 of its Dhaka day has passed; none after release. */
export function bedDaysDue(admitAt: Date, releasedAt: Date | null, now: Date): number {
  const first = dhakaDay(admitAt);
  const end = releasedAt && releasedAt < now ? releasedAt : now;
  let n = 1;
  while (dhakaMidnight(addDays(first, n)).getTime() + 60_000 <= end.getTime()) n++;
  return n;
}
const rateOf = (rates: Record<string, ClassRate>, c: string) => rates[c]?.perDayPaisa ?? 0;
/** The classes occupied during a Dhaka day (the census at its start, and every class arrived in during it). */
export function classesOnDay(legs: ClassLeg[], day: string, admitAt: Date): string[] {
  const start = Math.max(dhakaMidnight(day).getTime(), admitAt.getTime()), end = dhakaMidnight(addDays(day, 1)).getTime();
  return [...new Set(legs.filter((l) => l.from.getTime() < end && (l.to === null || l.to.getTime() > start)).map((l) => l.bedClass))];
}
/** The class a bed day is priced at: the highest-rate class occupied that day. */
export function dayClass(legs: ClassLeg[], day: string, admitAt: Date, rates: Record<string, ClassRate>): string | null {
  const cs = classesOnDay(legs, day, admitAt);
  if (!cs.length) return null;
  return cs.reduce((a, b) => (rateOf(rates, b) > rateOf(rates, a) ? b : a));
}
/** The package's class: of the classes occupied so far that the package has a price for, the dearest package price. */
export function packageClass(pkg: PackageSnapshot, legs: ClassLeg[], now: Date): string | null {
  const seen = [...new Set(legs.filter((l) => l.from <= now).map((l) => l.bedClass))].filter((c) => pkg.prices[c] !== undefined);
  if (!seen.length) return null;
  return seen.reduce((a, b) => (pkg.prices[b]! > pkg.prices[a]! ? b : a));
}

/** The lines the bill should have at `now`. */
export function desiredLines(f: StayFacts, now: Date): DesiredLine[] {
  const out: DesiredLine[] = [];
  const blank = { sourceId: null, batchId: null, medicineKey: null, serviceDay: null, dayNo: null, bedClass: null };
  const pkg = f.pkg;
  if (pkg) {
    const c = packageClass(pkg, f.legs, now);
    if (c) {
      const r = f.rates[c];
      out.push({ ...blank, key: "pkg", source: "package", tag: "package", code: `pkg:${pkg.code}`, nameEn: `${pkg.nameEn} · ${r?.nameEn ?? c}`, nameBn: `${pkg.nameBn} · ${r?.nameBn ?? c}`, unitPaisa: pkg.prices[c]!, qty: 1, vatRateBp: 0, sourceId: pkg.packageId, bedClass: c });
    }
  }
  const n = bedDaysDue(f.admitAt, f.releasedAt, now);
  const first = dhakaDay(f.admitAt);
  for (let d = 1; d <= n; d++) {
    const day = addDays(first, d - 1);
    const c = dayClass(f.legs, day, f.admitAt, f.rates);
    if (!c) continue;
    const r = f.rates[c];
    const inc = Boolean(pkg) && d <= pkg!.days;
    out.push({ ...blank, key: `bed:${d}`, source: "bed-day", tag: inc ? "included" : "excluded", code: `bed:${c}`,
      nameEn: `Bed · day ${d} · ${r?.nameEn ?? c}${pkg && !inc ? " (beyond package)" : ""}`, nameBn: `শয্যা · দিন ${d} · ${r?.nameBn ?? c}${pkg && !inc ? " (প্যাকেজের বাইরে)" : ""}`,
      unitPaisa: inc ? 0 : rateOf(f.rates, c), qty: 1, vatRateBp: 0, serviceDay: day, dayNo: d, bedClass: c });
  }
  // services count against the package's limits in the order they were placed (orders and manual charges alike)
  const used = new Map<string, number>();
  const covered = (code: string) => {
    const it = pkg?.services.find((x) => x.code === code);
    if (!it) return false;
    const k = used.get(code) ?? 0;
    if (it.limit !== null && k >= it.limit) return false;
    used.set(code, k + 1);
    return true;
  };
  const services = [
    ...f.orders.map((o) => ({ at: o.at, kind: "order" as const, o })),
    ...f.manual.map((m) => ({ at: m.at, kind: "manual" as const, m })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const x of services) {
    if (x.kind === "order") {
      const inc = covered(x.o.code);
      out.push({ ...blank, key: `order:${x.o.id}`, source: "order", tag: inc ? "included" : "excluded", code: x.o.code, nameEn: x.o.nameEn, nameBn: x.o.nameBn, unitPaisa: inc ? 0 : x.o.unitPaisa, qty: 1, vatRateBp: x.o.vatRateBp, sourceId: x.o.id });
    } else {
      // a manual charge of several units: each unit counts against the limit
      const inc = Array.from({ length: x.m.qty }, () => covered(x.m.code)).every(Boolean);
      out.push({ ...blank, key: `manual:${x.m.id}`, source: "desk", tag: inc ? "included" : "excluded", code: x.m.code, nameEn: x.m.nameEn, nameBn: x.m.nameBn, unitPaisa: inc ? 0 : x.m.unitPaisa, qty: x.m.qty, vatRateBp: x.m.vatRateBp, sourceId: x.m.id });
    }
  }
  for (const st of [...f.stock].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (st.units <= 0) continue;
    const inc = Boolean(pkg?.medicines.includes(st.medicineKey));
    out.push({ ...blank, key: st.key, source: "stock", tag: inc ? "included" : "excluded", code: `med:${st.medicineKey}`, nameEn: st.nameEn, nameBn: st.nameBn, unitPaisa: inc ? 0 : st.unitPaisa, qty: st.units, vatRateBp: st.vatRateBp, sourceId: st.refId, batchId: st.batchId, medicineKey: st.medicineKey });
  }
  return out;
}

/* ───── reconcile ───── */
export interface PostedLine { id: string; key: string | null; tag: IpdTag | null; unitPaisa: Paisa | null; qty: number; vatRateBp: number; superseded: boolean; credited: boolean; creditOfId: string | null }
export interface Reconcile { add: DesiredLine[]; supersede: { oldId: string; line: DesiredLine }[]; credit: string[] }
const sameLine = (p: PostedLine, d: DesiredLine) => p.tag === d.tag && p.unitPaisa === d.unitPaisa && p.qty === d.qty && p.vatRateBp === d.vatRateBp;
/** What to write so the posted lines become the desired ones: keep the unchanged, supersede the changed, add the new,
    credit the ones no longer wanted. Lines without a key (none on an IPD bill) are left alone. */
export function reconcileLines(posted: PostedLine[], desired: DesiredLine[]): Reconcile {
  const live = new Map(posted.filter((p) => p.key && !p.superseded && !p.credited && !p.creditOfId).map((p) => [p.key!, p]));
  const out: Reconcile = { add: [], supersede: [], credit: [] };
  const want = new Set<string>();
  for (const d of desired) {
    if (want.has(d.key)) throw new Error(`desiredLines: duplicate key ${d.key}`);
    want.add(d.key);
    const p = live.get(d.key);
    if (!p) out.add.push(d);
    else if (!sameLine(p, d)) out.supersede.push({ oldId: p.id, line: d });
  }
  for (const [k, p] of live) if (!want.has(k)) out.credit.push(p.id);
  return out;
}

/* ───── amounts and totals ───── */
/** A line's amounts; a credit line has a negative quantity and mirrors its original exactly. */
export function ipdLineAmounts(unitPaisa: Paisa | null, qty: number, vatRateBp: number) {
  const sign = qty < 0 ? -1 : 1, q = Math.abs(qty), u = unitPaisa ?? 0;
  const gross = u * q;
  if (!Number.isSafeInteger(gross) || gross > MAX_PAISA) throw new RangeError("line amount is above the supported maximum");
  const vat = vatOn(gross, vatRateBp);
  const signed = (n: number) => (sign < 0 ? 0 - n : n); // 0 − 0 is 0, never −0
  return { grossPaisa: signed(gross), discountPaisa: 0, netPaisa: signed(gross), vatPaisa: signed(vat), totalPaisa: signed(gross + vat) };
}
export interface TotalsLine { tag: IpdTag | null; unitPaisa: Paisa | null; qty: number; vatRateBp: number; superseded: boolean }
export interface IpdTotals { packagePaisa: Paisa; excludedPaisa: Paisa; includedLines: number; subtotalPaisa: Paisa; vatPaisa: Paisa; totalPaisa: Paisa; unpriced: number }
/** Totals over the lines that are not superseded (credit lines count, negative). */
export function ipdTotals(lines: TotalsLine[]): IpdTotals {
  const t: IpdTotals = { packagePaisa: 0, excludedPaisa: 0, includedLines: 0, subtotalPaisa: 0, vatPaisa: 0, totalPaisa: 0, unpriced: 0 };
  for (const l of lines) {
    if (l.superseded) continue;
    if (l.unitPaisa === null) t.unpriced++;
    const a = ipdLineAmounts(l.unitPaisa, l.qty, l.vatRateBp);
    t.subtotalPaisa += a.netPaisa; t.vatPaisa += a.vatPaisa; t.totalPaisa += a.totalPaisa;
    if (l.tag === "package") t.packagePaisa += a.totalPaisa;
    else if (l.tag === "excluded") t.excludedPaisa += a.totalPaisa;
    else if (l.tag === "included" && l.qty > 0) t.includedLines++;
  }
  return t;
}

/* ───── deposits ───── */
export const LOW_DEPOSIT_DAYS = 2;
/** The most one deposit payment may be (a running bill has no "due" to cap it). */
export const MAX_DEPOSIT_PAISA = 50_000_000;
export type DepositState = "ok" | "low" | "due";
/** Balance = deposits − patient share. Due when negative; low when under two days of the current class's rate. */
export function depositState(balancePaisa: Paisa, perDayPaisa: Paisa): DepositState {
  if (balancePaisa < 0) return "due";
  return balancePaisa < LOW_DEPOSIT_DAYS * perDayPaisa ? "low" : "ok";
}
/** The top-up a payment link suggests: back to two days of the class's rate above the patient share. */
export const suggestedTopUp = (balancePaisa: Paisa, perDayPaisa: Paisa): Paisa => Math.max(0, LOW_DEPOSIT_DAYS * perDayPaisa - balancePaisa);

/* ───── the class-change preview ───── */
export interface ClassPreviewInput {
  from: string; to: string; rates: Record<string, ClassRate>;
  /** today's bed day number and the package (null = none) */ dayNo: number; pkg: PackageSnapshot | null;
  /** the package price posted now (null = no package line) */ packageNowPaisa: Paisa | null;
}
export interface ClassPreview {
  direction: "up" | "down" | "same"; appliesFrom: "today" | "tomorrow";
  perDayFromPaisa: Paisa; perDayToPaisa: Paisa;
  packageFromPaisa: Paisa | null; packageToPaisa: Paisa | null;
  /** estimated extra for the patient (negative = saving): the package difference and the next two bed days the
      difference applies to, counting only days past the package */ extraPaisa: number; estDays: number;
}
export const PREVIEW_EST_DAYS = 2;
export function classPreview(x: ClassPreviewInput): ClassPreview {
  const a = rateOf(x.rates, x.from), b = rateOf(x.rates, x.to);
  const direction = b > a ? "up" : b < a ? "down" : "same";
  const appliesFrom = direction === "up" ? "today" : "tomorrow";
  // the package follows the dearest class occupied so far: only a move up can raise it
  const pkgTo = x.pkg ? x.pkg.prices[x.to] ?? null : null;
  const packageToPaisa = x.packageNowPaisa !== null && pkgTo !== null && direction === "up" ? Math.max(x.packageNowPaisa, pkgTo) : x.packageNowPaisa;
  const firstDay = appliesFrom === "today" ? x.dayNo : x.dayNo + 1;
  const pkgDays = x.pkg?.days ?? 0;
  let billable = 0;
  for (let d = firstDay; d < firstDay + PREVIEW_EST_DAYS; d++) if (d > pkgDays) billable++;
  const extraPaisa = (packageToPaisa ?? 0) - (x.packageNowPaisa ?? 0) + (b - a) * billable;
  return { direction, appliesFrom, perDayFromPaisa: a, perDayToPaisa: b, packageFromPaisa: x.packageNowPaisa, packageToPaisa, extraPaisa, estDays: PREVIEW_EST_DAYS };
}
