"use client";
/* Offline outbox (CLAUDE.md rule 1: a write is pending until the server acknowledges it). A write that cannot reach the
   server is kept on this device with its Idempotency-Key and replayed, in order, when the browser is back online —
   the key makes a replay safe. Screens show "Saved on this device · not synced" for it, never "Saved". */
export interface OutboxItem { id: string; owner: string; method: string; path: string; body: unknown; key: string; label: string; at: string; error?: string; errorBn?: string; status?: number }
const KEY = "setu.outbox";
const MAX_AGE_MS = 24 * 3600_000;
const listeners = new Set<(pending: number, refused: number) => void>();
/* Each queued write belongs to the user + tenant + facility that made it; it is only ever replayed under that same
   session (security review A1–A3: a shared desk PC must never send one user's registration under another login). */
let owner: string | null = null;
export function setOutboxOwner(o: { userId: string; tenantId: string; organizationId: string } | null) {
  owner = o ? `${o.tenantId}:${o.organizationId}:${o.userId}` : null;
  save(load());
  if (owner) void flush();
}

/* Pending writes expire after 24 h; refused ones (no body any more) stay listed for 7 days so none disappears unseen. */
const REFUSED_MAX_AGE_MS = 7 * 24 * 3600_000;
const fresh = (i: OutboxItem) => Date.now() - Date.parse(i.at) < (i.error ? REFUSED_MAX_AGE_MS : MAX_AGE_MS);
/* A pending write older than 24 h is not replayed: it becomes a refused item ("not sent within 24 hours"), without its
   body, so staff see it and redo the work (clinical review: never a silent drop). */
const expire = (i: OutboxItem): OutboxItem => (!i.error && !fresh(i)
  ? { ...i, body: null, at: new Date().toISOString(), error: "Not sent within 24 hours — redo it", errorBn: "২৪ ঘণ্টার মধ্যে পাঠানো যায়নি — আবার করুন", status: 0 }
  : i);
const load = (): OutboxItem[] => { try { return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as OutboxItem[]).map(expire).filter((i) => i.owner && fresh(i)); } catch { return []; } };
const mine = (items: OutboxItem[]) => items.filter((i) => owner !== null && i.owner === owner && !i.error);
/* Writes the server refused after an offline save (e.g. 409 visit already exists, 400 validation) stay listed, with the
   reason, until staff have checked them (open question 22): never a silent drop from the pending count. */
const refused = (items: OutboxItem[]) => items.filter((i) => owner !== null && i.owner === owner && Boolean(i.error));
function save(items: OutboxItem[]) { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {} listeners.forEach((f) => f(mine(items).length, refused(items).length)); }

export const outboxItems = () => load().filter((i) => i.owner === owner);
export const pendingCount = () => mine(load()).length;
export const refusedItems = () => refused(load());
/** Staff have checked a refused write: take it off the list. */
export function dismissRefused(id: string) { save(load().filter((i) => !(i.id === id && i.error && i.owner === owner))); }
/** Sign-out: this user's refused items go with the session (a shared desk PC keeps nothing of theirs to read). */
export function clearRefusedForOwner() { if (owner) save(load().filter((i) => !(i.owner === owner && i.error))); }
export function onOutbox(f: (pending: number, refused: number) => void) { listeners.add(f); return () => { listeners.delete(f); }; }

/** False when nobody is signed in: then nothing is queued and the caller must report "not saved". */
export function enqueue(item: Omit<OutboxItem, "id" | "at" | "owner">): boolean {
  if (!owner) return false;
  const items = load();
  if (!items.some((i) => i.key === item.key)) items.push({ ...item, owner, id: crypto.randomUUID(), at: new Date().toISOString() });
  save(items);
  return true;
}

let flushing = false;
/** Replays queued writes in order. Stops at the first network failure; a server refusal is kept, marked, and skipped. */
export async function flush(): Promise<void> {
  if (flushing || typeof navigator !== "undefined" && !navigator.onLine) return;
  flushing = true;
  try {
    for (const it of mine(load())) {
      let r: Response;
      try {
        r = await fetch("/api" + it.path, { method: it.method, credentials: "include", headers: { "content-type": "application/json", "idempotency-key": it.key }, body: JSON.stringify(it.body) });
      } catch { return; }
      const rest = load();
      if (r.ok) save(rest.filter((x) => x.id !== it.id));
      else if (r.status >= 500 || r.status === 401) return; // signed out meanwhile: keep it for this user
      else {
        let msg = r.statusText, msgBn: string | undefined;
        try { const b = (await r.json()) as { message_en?: string; message_bn?: string }; msg = b.message_en ?? msg; msgBn = b.message_bn; } catch {}
        // The refused write's body (patient details, values) is dropped: only what staff need to find it is kept.
        save(rest.map((x) => (x.id === it.id ? { ...x, body: null, error: msg, errorBn: msgBn, status: r.status } : x)));
      }
    }
  } finally { flushing = false; }
}
if (typeof window !== "undefined") window.addEventListener("online", () => { void flush(); });
