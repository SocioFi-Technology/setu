"use client";
import { SaveDraftRequest } from "@setu/contracts";
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
const LAST_OWNER = "setu.outbox.lastOwner";
export function setOutboxOwner(o: { userId: string; tenantId: string; organizationId: string } | null) {
  owner = o ? `${o.tenantId}:${o.organizationId}:${o.userId}` : null;
  if (owner) try { localStorage.setItem(LAST_OWNER, owner); } catch {}
  drafts(); // security review A5: expired device drafts go at app start and at every sign-in, not only when used
  save(load());
  if (owner) void flush();
}
/** The session expired without a sign-out (security review A5): the last user's device drafts go as at sign-out. */
export function clearDraftsForLastOwner() {
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_OWNER); } catch {}
  if (last) storeDrafts(rawDrafts().filter((x) => x.owner !== last));
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
function save(items: OutboxItem[]) { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {} listeners.forEach((f) => f(mine(items).length + myDrafts(rawDrafts()).length, refused(items).length)); }

export const outboxItems = () => load().filter((i) => i.owner === owner);
/** Writes waiting on this device: queued writes plus consultation drafts not yet on the server. */
export const pendingCount = () => mine(load()).length + myDrafts(drafts()).length;
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

let flushRun: Promise<void> | null = null;
/** Replays queued writes in order, then the consultation drafts kept on this device. Stops at the first network failure;
    a server refusal is kept, marked, and skipped. A call while a replay runs gets that same replay, so a screen can await
    it and then read what is left. */
export function flush(): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return Promise.resolve();
  flushRun ??= (async () => { try { await flushWrites(); await flushDrafts(); } finally { flushRun = null; } })();
  return flushRun;
}
async function flushWrites(): Promise<void> {
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
}

/* ── Consultation drafts kept on this device (Kamrul 02/10/2026) ──
   A note draft the server has not acknowledged is kept here per user + tenant + facility, at most 24 h, and is cleared
   at sign-out. It is replayed with the version (`rev`) it was based on, so it can never overwrite a newer note: when the
   note changed on the server meanwhile (409 stale) the device copy is kept, marked `conflict`, for the doctor to load
   into the note or discard. Nothing here can sign: signing needs the server (decision 25). */
export interface DeviceDraft {
  owner: string; compositionId: string; encounterId: string; baseRev: number; body: Omit<SaveDraftRequest, "rev">;
  /** the screen's copy with labels, so "Load the device copy" needs no catalogue lookup (never sent) */
  form?: unknown;
  key: string; at: string; conflict?: boolean;
}
const DKEY = "setu.cons.drafts";
const rawDrafts = (): DeviceDraft[] => { try { return JSON.parse(localStorage.getItem(DKEY) ?? "[]") as DeviceDraft[]; } catch { return []; } };
const storeDrafts = (d: DeviceDraft[]) => { try { localStorage.setItem(DKEY, JSON.stringify(d)); } catch {} };
const myDrafts = (d: DeviceDraft[]) => d.filter((x) => owner !== null && x.owner === owner);
/* A device draft older than 24 h is removed with its text and becomes a refused item ("not sent within 24 hours"), so
   the doctor sees that the work did not reach the server (same rule as the outbox: never a silent drop). */
function drafts(): DeviceDraft[] {
  const all = rawDrafts();
  const old = all.filter((d) => !(Date.now() - Date.parse(d.at) < MAX_AGE_MS));
  if (!old.length) return all;
  const keep = all.filter((d) => !old.includes(d));
  storeDrafts(keep);
  save([...load(), ...old.map((d): OutboxItem => ({
    id: crypto.randomUUID(), owner: d.owner, method: "PUT", path: `/v1/compositions/${d.compositionId}`, body: null, key: d.key, label: "note_draft",
    at: new Date().toISOString(), error: "Note draft not sent within 24 hours — redo it", errorBn: "নোটের খসড়া ২৪ ঘণ্টার মধ্যে পাঠানো যায়নি — আবার করুন", status: 0,
  }))]);
  return keep;
}
function notify() { save(load()); }

/** Keeps the latest unsent draft of a note on this device. False when nobody is signed in (nothing is kept).
    `key`: pass the key of a save that failed on the network, so a replay of that same body is the same request (if the
    server did commit it, the replay returns the stored answer instead of a false conflict). A changed body needs a new key. */
export function saveDeviceDraft(d: Pick<DeviceDraft, "compositionId" | "encounterId" | "baseRev" | "body" | "form" | "conflict">, key: string = crypto.randomUUID()): boolean {
  if (!owner) return false;
  const o = owner;
  const all = drafts();
  const prev = all.find((x) => x.owner === o && x.compositionId === d.compositionId);
  // The 24 h limit counts from the first change the server has not seen, not from the latest one (clinical review A5).
  const at = prev?.at ?? new Date().toISOString();
  storeDrafts([...all.filter((x) => x !== prev), { ...d, owner: o, key, at }]);
  notify();
  return true;
}
/** This user's consultation drafts not yet on the server (incl. conflict copies). */
export const deviceDraftCount = () => myDrafts(drafts()).length;
export const deviceDraft = (compositionId: string): DeviceDraft | null => myDrafts(drafts()).find((x) => x.compositionId === compositionId) ?? null;
export function dropDeviceDraft(compositionId: string) { if (owner) { const o = owner; storeDrafts(drafts().filter((x) => !(x.owner === o && x.compositionId === compositionId))); notify(); } }
/** Sign-out: this user's device drafts go with the session (a shared PC keeps no note text of theirs). */
export function clearDraftsForOwner() { if (owner) { const o = owner; storeDrafts(rawDrafts().filter((x) => x.owner !== o)); notify(); } }

async function flushDrafts(): Promise<void> {
  for (const d of myDrafts(drafts()).filter((x) => !x.conflict)) {
    // Only a well-formed note body is ever sent (security review A5: localStorage is not trusted input).
    if (!SaveDraftRequest.omit({ rev: true }).safeParse(d.body).success || !Number.isInteger(d.baseRev)) {
      storeDrafts(rawDrafts().filter((x) => !(x.owner === d.owner && x.key === d.key)));
      save([...load(), { id: crypto.randomUUID(), owner: d.owner, method: "PUT", path: `/v1/compositions/${d.compositionId}`, body: null, key: d.key, label: "note_draft", at: new Date().toISOString(), error: "Note draft on this device was damaged — not sent", errorBn: "এই ডিভাইসের নোটের খসড়া নষ্ট — পাঠানো হয়নি", status: 0 }]);
      continue;
    }
    let r: Response;
    try {
      r = await fetch("/api" + `/v1/compositions/${encodeURIComponent(d.compositionId)}`, { method: "PUT", credentials: "include", headers: { "content-type": "application/json", "idempotency-key": d.key }, body: JSON.stringify({ ...d.body, rev: d.baseRev }) });
    } catch { return; }
    if (r.status >= 500 || r.status === 401) return;
    let code = "";
    let msg = r.statusText, msgBn: string | undefined;
    if (!r.ok) try { const b = (await r.json()) as { code?: string; message_en?: string; message_bn?: string }; code = b.code ?? ""; msg = b.message_en ?? msg; msgBn = b.message_bn; } catch {}
    const rest = rawDrafts();
    // Only the same device copy is touched: the doctor may have typed again (new key) while this one was in flight.
    const same = (x: DeviceDraft) => x.owner === d.owner && x.compositionId === d.compositionId && x.key === d.key;
    if (r.ok) storeDrafts(rest.filter((x) => !same(x)));
    else if (r.status === 409 && code === "stale") storeDrafts(rest.map((x) => (same(x) ? { ...x, conflict: true } : x)));
    else {
      // Refused for another reason (note signed meanwhile, access changed): listed with the reason, without the text.
      storeDrafts(rest.filter((x) => !same(x)));
      save([...load(), { id: crypto.randomUUID(), owner: d.owner, method: "PUT", path: `/v1/compositions/${d.compositionId}`, body: null, key: d.key, label: "note_draft", at: new Date().toISOString(), error: msg, errorBn: msgBn, status: r.status }]);
    }
    notify();
  }
}
if (typeof window !== "undefined") window.addEventListener("online", () => { void flush(); });
