"use client";
/* Offline outbox (CLAUDE.md rule 1: a write is pending until the server acknowledges it). A write that cannot reach the
   server is kept on this device with its Idempotency-Key and replayed, in order, when the browser is back online —
   the key makes a replay safe. Screens show "Saved on this device · not synced" for it, never "Saved". */
export interface OutboxItem { id: string; owner: string; method: string; path: string; body: unknown; key: string; label: string; at: string; error?: string }
const KEY = "setu.outbox";
const MAX_AGE_MS = 24 * 3600_000;
const listeners = new Set<(n: number) => void>();
/* Each queued write belongs to the user + tenant + facility that made it; it is only ever replayed under that same
   session (security review A1–A3: a shared desk PC must never send one user's registration under another login). */
let owner: string | null = null;
export function setOutboxOwner(o: { userId: string; tenantId: string; organizationId: string } | null) {
  owner = o ? `${o.tenantId}:${o.organizationId}:${o.userId}` : null;
  save(load());
  if (owner) void flush();
}

const fresh = (i: OutboxItem) => Date.now() - Date.parse(i.at) < MAX_AGE_MS;
const load = (): OutboxItem[] => { try { return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as OutboxItem[]).filter((i) => i.owner && fresh(i)); } catch { return []; } };
const mine = (items: OutboxItem[]) => items.filter((i) => owner !== null && i.owner === owner && !i.error);
function save(items: OutboxItem[]) { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {} listeners.forEach((f) => f(mine(items).length)); }

export const outboxItems = () => load().filter((i) => i.owner === owner);
export const pendingCount = () => mine(load()).length;
export function onOutbox(f: (n: number) => void) { listeners.add(f); return () => { listeners.delete(f); }; }

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
      else { let msg = r.statusText; try { msg = ((await r.json()) as { message_en?: string }).message_en ?? msg; } catch {} save(rest.map((x) => (x.id === it.id ? { ...x, error: msg } : x))); }
    }
  } finally { flushing = false; }
}
if (typeof window !== "undefined") window.addEventListener("online", () => { void flush(); });
