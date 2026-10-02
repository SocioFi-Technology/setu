/** Money is stored as integer paisa. ৳1 = 100 paisa. */
export type Paisa = number;
export const taka = (t: number): Paisa => Math.round(t * 100);
export const toTaka = (p: Paisa): number => p / 100;
/** VAT in basis points on a line (1500 = 15%). Rounds half up to the nearest paisa. */
export const vatOn = (net: Paisa, rateBp: number): Paisa => Math.round((net * rateBp) / 10_000);
export const sum = (xs: Paisa[]): Paisa => xs.reduce((a, b) => a + b, 0);
