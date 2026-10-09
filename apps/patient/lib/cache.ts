/* ADR 0020: the history reads offline from the last copy seen on this phone. It is the patient's own data on their own
   phone; sign-out removes it (a shared phone keeps nothing after sign-out). */
const PREFIX = "setu_patient_cache:";
export function keep<T>(key: string, value: T) { try { localStorage.setItem(PREFIX + key, JSON.stringify({ at: new Date().toISOString(), value })); } catch {} }
export function seen<T>(key: string): { at: string; value: T } | null { try { const s = localStorage.getItem(PREFIX + key); return s ? JSON.parse(s) : null; } catch { return null; } }
export function forgetAll() { try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k); } catch {} }
