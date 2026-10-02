/** Money is stored as integer paisa. ৳1 = 100 paisa. Every amount in the database, the contracts and the screens is a
    whole number of paisa; taka with decimals exist only inside `format` when a number is printed. */
export type Paisa = number;
/** Upper bound for any single stored amount (৳1 crore): keeps products like amount × rate well inside safe integers
    and every column inside Postgres `integer`. */
export const MAX_PAISA = 1_000_000_000;
export const taka = (t: number): Paisa => Math.round(t * 100);
export const toTaka = (p: Paisa): number => p / 100;

export function assertPaisa(n: number, what = "amount"): Paisa {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_PAISA) throw new RangeError(`${what} must be whole paisa between 0 and ${MAX_PAISA} (got ${n})`);
  return n;
}

/** The one rounding rule: n / d rounded half-up, in integer arithmetic (n ≥ 0, d > 0). */
export function divHalfUp(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n < 0 || d <= 0) throw new RangeError(`divHalfUp(${n}, ${d})`);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return 2 * r >= d ? q + 1 : q;
}

/** VAT in basis points on a line (1500 = 15%), half-up to the paisa. */
export const vatOn = (net: Paisa, rateBp: number): Paisa => {
  assertPaisa(net, "net");
  if (!Number.isSafeInteger(rateBp) || rateBp < 0 || rateBp > 10_000) throw new RangeError(`VAT rate ${rateBp} bp`);
  return divHalfUp(net * rateBp, 10_000);
};
export const sum = (xs: Paisa[]): Paisa => xs.reduce((a, b) => a + b, 0);

/** What a cashier types ("2,300", "500.5", "৫০০.৫০") → whole paisa, without floating point; null when it is not an
    amount (more than 2 decimals, letters, negative, above MAX_PAISA). */
export function parseTaka(input: string): Paisa | null {
  const s = input.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))).replace(/[,\s৳]/g, "");
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const p = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return p <= MAX_PAISA ? p : null;
}
/** A percent as typed ("10", "2.5") → basis points (1000, 250); null when not 0–100 with at most 2 decimals. */
export function parsePercentBp(input: string): number | null {
  const s = input.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))).replace(/[\s%]/g, "");
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}
