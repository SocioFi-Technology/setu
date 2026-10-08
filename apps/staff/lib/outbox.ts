"use client";
import { SaveDraftRequest } from "@setu/contracts";
import { t as tr } from "@setu/i18n";
import { importMacKey, importSealKey, open, ownerTag, seal, signQueued, type DeviceKey } from "./devicekeys";
/* Offline outbox (CLAUDE.md rule 1: a write is pending until the server acknowledges it). A write that cannot reach the
   server is kept on this device with its Idempotency-Key and replayed, in order, when the browser is back online —
   the key makes a replay safe. Screens show "Saved on this device · not synced" for it, never "Saved". */
export interface OutboxItem { id: string; owner: string; method: string; path: string; body: unknown; key: string; label: string; at: string; error?: string; errorBn?: string; status?: number;
  /** kept when a payment is refused (method and amount, no patient data): money in the drawer must never vanish unrecorded */
  summary?: { method: string; amountPaisa: number } }
const MAX_AGE_MS = 24 * 3600_000;
/** A refusal reason in both languages (shellApp strings), as stored on the item. */
const bi = (key: string) => ({ error: tr("en", "shellApp", key), errorBn: tr("bn", "shellApp", key) });
const listeners = new Set<(pending: number, refused: number, unreadable: number) => void>();
/* Each queued write belongs to the user + tenant + facility that made it; it is only ever replayed under that same
   session (security review A1–A3: a shared desk PC must never send one user's registration under another login) —
   and since gap 10 the server checks that too (x-setu-queued-by + this device's signature). */
let owner: string | null = null;

/* ── Gap 10 (Kamrul 07/10/2026, option b): what is stored is sealed ──
   localStorage holds only envelopes { k: write | draft, o: owner tag, at, kid, iv, ct } (AES-GCM); the readable copy
   lives in memory while a session holds the keys (devicekeys.ts). Writes are sealed with the outbox key (this user on
   this device: a queued write survives the same person signing in again); drafts with the draft key (this sign-in: an
   earlier session's drafts become unreadable — counted, gone at 24 h). An entry of this owner under the current key
   that does not open was changed: dropped. One under a key this device never had for this owner was copied in: dropped.
   Both are reported (/v1/device/dropped, audited and flagged). Other users' entries are left alone. */
interface Env { v: 2; k: "w" | "d"; o: string; at: string; kid: string; iv: string; ct: string }
const EKEY = "setu.device.v2";
const KIDS = "setu.device.kids";
let tag: string | null = null;
let keys: { draft: DeviceKey; outbox: DeviceKey; mac: CryptoKey } | null = null;
let items: OutboxItem[] = [];
let draftsMem: DeviceDraft[] = [];
/** envelopes this session does not read: other users', and this user's from an earlier sign-in (unreadable) */
let kept: Env[] = [];
let unreadable = 0;
let ready: Promise<void> = Promise.resolve();
const readEnvs = (): Env[] => { try { const v = JSON.parse(localStorage.getItem(EKEY) ?? "[]") as Env[]; return Array.isArray(v) ? v.filter((e) => e && e.v === 2) : []; } catch { return []; } };
const ageOk = (e: Env) => Date.now() - Date.parse(e.at) < (e.k === "w" ? REFUSED_MAX_AGE_MS : MAX_AGE_MS);
let writing: Promise<void> = Promise.resolve();
/** Seals what this session holds and stores it beside the envelopes it does not read. In order, one at a time. */
function persist() {
  // what to store is taken now — a sign-out right after (keys dropped) must still store this change, e.g. a deletion
  const snap = { wait: ready, k: keys, t: tag, w: items, d: draftsMem, kept };
  writing = writing.then(async () => {
    await snap.wait;
    const k = snap.k ?? keys, t = snap.t ?? tag;
    if (!k || !t) return;
    const mine = await Promise.all([
      ...snap.w.map(async (i): Promise<Env> => ({ v: 2, k: "w", o: t, at: i.at, ...(await seal(k.outbox, i)) })),
      ...snap.d.map(async (d): Promise<Env> => ({ v: 2, k: "d", o: t, at: d.at, ...(await seal(k.draft, d)) })),
    ]);
    try { localStorage.setItem(EKEY, JSON.stringify([...(snap.k ? snap.kept : kept).filter(ageOk), ...mine])); } catch {}
  }).catch(() => undefined);
  return writing;
}
async function openSession(o: string, dk: { draft: string; outbox: string; queue: string }) {
  const t = await ownerTag(o);
  const k = { draft: await importSealKey(dk.draft), outbox: await importSealKey(dk.outbox), mac: await importMacKey(dk.queue) };
  // the keys this device has had for this owner: an entry under one of them is this user's own (unreadable now), not foreign
  let known: Record<string, string[]> = {};
  try { known = JSON.parse(localStorage.getItem(KIDS) ?? "{}") as Record<string, string[]>; } catch {}
  const past = new Set(known[t] ?? []);
  known[t] = [...new Set([...(known[t] ?? []), k.draft.kid, k.outbox.kid])].slice(-50);
  try { localStorage.setItem(KIDS, JSON.stringify(known)); } catch {}
  const w: OutboxItem[] = [], d: DeviceDraft[] = [], keep: Env[] = [];
  let tampered = 0, foreign = 0, unread = 0; const kinds = new Set<"write" | "draft">();
  for (const e of readEnvs()) {
    if (!ageOk(e)) continue; // expired: gone
    if (e.o !== t) { keep.push(e); continue; }
    const key = e.k === "d" ? k.draft : k.outbox;
    if (e.kid === key.kid) {
      const v = await open<OutboxItem & DeviceDraft>(key, e);
      if (v && v.owner === o) (e.k === "d" ? d : w).push(v);
      else { tampered++; kinds.add(e.k === "d" ? "draft" : "write"); }
    } else if (past.has(e.kid)) { keep.push(e); if (Date.now() - Date.parse(e.at) < MAX_AGE_MS) unread++; }
    else { foreign++; kinds.add(e.k === "d" ? "draft" : "write"); }
  }
  // the plain stores from before gap 10: this user's entries are taken in (and sealed), the rest left as they were
  try {
    const lw = JSON.parse(localStorage.getItem("setu.outbox") ?? "[]") as OutboxItem[], ld = JSON.parse(localStorage.getItem("setu.cons.drafts") ?? "[]") as DeviceDraft[];
    w.push(...lw.filter((x) => x && x.owner === o)); d.push(...ld.filter((x) => x && x.owner === o));
    const lwRest = lw.filter((x) => x && x.owner !== o), ldRest = ld.filter((x) => x && x.owner !== o);
    if (lwRest.length) localStorage.setItem("setu.outbox", JSON.stringify(lwRest)); else localStorage.removeItem("setu.outbox");
    if (ldRest.length) localStorage.setItem("setu.cons.drafts", JSON.stringify(ldRest)); else localStorage.removeItem("setu.cons.drafts");
  } catch {}
  if (owner !== o) return; // signed out (or another user) meanwhile
  // anything queued while the keys were still opening is kept beside what was stored
  tag = t; keys = k; kept = keep; unreadable = unread;
  items = [...w, ...items.filter((x) => !w.some((y) => y.id === x.id || y.key === x.key))];
  draftsMem = [...d.filter((x) => !draftsMem.some((y) => y.compositionId === x.compositionId)), ...draftsMem];
  for (const [reason, n] of [["tampered", tampered], ["foreign", foreign]] as const)
    if (n) void fetch("/api/v1/device/dropped", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: n, reason, kinds: [...kinds] }) }).catch(() => undefined);
}
export function setOutboxOwner(o: { userId: string; tenantId: string; organizationId: string; deviceKeys?: { draft: string; outbox: string; queue: string } } | null) {
  const next = o ? `${o.tenantId}:${o.organizationId}:${o.userId}` : null;
  if (next === owner && (keys || !o?.deviceKeys)) return;
  owner = next;
  // the keys go with the session: nothing readable is left in memory for the next person
  keys = null; tag = null; items = []; draftsMem = []; kept = []; unreadable = 0;
  ready = next && o?.deviceKeys ? openSession(next, o.deviceKeys).catch(() => undefined) : Promise.resolve();
  void ready.then(() => {
    drafts(); // security review A5: expired device drafts go at app start and at every sign-in, not only when used
    save(load());
    if (owner) void flush();
  });
}
/** The session ended without a sign-out: the key is gone with it, so the drafts it sealed are unreadable — listed as a
    count at the next sign-in and gone at 24 h (Kamrul 07/10/2026). Nothing to delete here. */
export function clearDraftsForLastOwner() {}
/** This user's entries from an earlier sign-in that cannot be read any more (shown as "not sent, unreadable"). */
export const unreadableCount = () => unreadable;

/* Pending writes expire after 24 h; refused ones (no body any more) stay listed for 7 days so none disappears unseen. */
const REFUSED_MAX_AGE_MS = 7 * 24 * 3600_000;
const fresh = (i: OutboxItem) => Date.now() - Date.parse(i.at) < (i.error ? REFUSED_MAX_AGE_MS : MAX_AGE_MS);
/* A pending write older than 24 h is not replayed: it becomes a refused item ("not sent within 24 hours"), without its
   body, so staff see it and redo the work (clinical review: never a silent drop). */
const expire = (i: OutboxItem): OutboxItem => (!i.error && !fresh(i)
  ? { ...i, body: null, at: new Date().toISOString(), ...bi("outbox_expired"), status: 0 }
  : i);
const load = (): OutboxItem[] => items.map(expire).filter((i) => i.owner && fresh(i));
const mine = (items: OutboxItem[]) => items.filter((i) => owner !== null && i.owner === owner && !i.error);
/* Writes the server refused after an offline save (e.g. 409 visit already exists, 400 validation) stay listed, with the
   reason, until staff have checked them (open question 22): never a silent drop from the pending count. */
const refused = (items: OutboxItem[]) => items.filter((i) => owner !== null && i.owner === owner && Boolean(i.error));
function save(next: OutboxItem[]) { items = next; void persist(); listeners.forEach((f) => f(mine(next).length + myDrafts(rawDrafts()).length, refused(next).length, unreadable)); }

export const outboxItems = () => load().filter((i) => i.owner === owner);
/** Writes waiting on this device: queued writes plus consultation drafts not yet on the server. */
export const pendingCount = () => mine(load()).length + myDrafts(drafts()).length;
export const refusedItems = () => refused(load());
/** Staff have checked a refused write: take it off the list. */
export function dismissRefused(id: string) { save(load().filter((i) => !(i.id === id && i.error && i.owner === owner))); }
/** Sign-out: this user's refused items go with the session (a shared desk PC keeps nothing of theirs to read). */
export function clearRefusedForOwner() { if (owner) save(load().filter((i) => !(i.owner === owner && i.error))); }
export function onOutbox(f: (pending: number, refused: number, unreadable: number) => void) { listeners.add(f); return () => { listeners.delete(f); }; }

/** False when nobody is signed in: then nothing is queued and the caller must report "not saved". */
export function enqueue(item: Omit<OutboxItem, "id" | "at" | "owner">): boolean {
  if (!owner) return false;
  const items = load();
  if (!items.some((i) => i.key === item.key)) items.push({ ...item, owner, id: crypto.randomUUID(), at: new Date().toISOString() });
  save(items);
  return true;
}

/** Gap 10: who queued it and this device's signature — the server sends it on only for that user, from this device. */
async function queuedHeaders(method: string, path: string, key: string): Promise<Record<string, string>> {
  if (!keys || !owner) return {};
  return { "x-setu-queued-by": owner.split(":").pop()!, "x-setu-queued-sig": await signQueued(keys.mac, method, path, key) };
}
let flushRun: Promise<void> | null = null;
/** Replays queued writes in order, then the consultation drafts kept on this device. Stops at the first network failure;
    a server refusal is kept, marked, and skipped. A call while a replay runs gets that same replay, so a screen can await
    it and then read what is left. */
export function flush(): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return Promise.resolve();
  flushRun ??= (async () => { try { await ready; if (!keys) return; await flushWrites(); await flushDrafts(); } finally { flushRun = null; } })();
  return flushRun;
}
async function flushWrites(): Promise<void> {
  for (const it of mine(load())) {
    let r: Response;
    try {
      r = await fetch("/api" + it.path, { method: it.method, credentials: "include", headers: { "content-type": "application/json", "idempotency-key": it.key, ...(await queuedHeaders(it.method, it.path, it.key)) }, body: JSON.stringify(it.body) });
    } catch { return; }
    const rest = load();
    if (r.ok) save(rest.filter((x) => x.id !== it.id));
    else if (r.status >= 500 || r.status === 401) return; // signed out meanwhile: keep it for this user
    else {
      let msg = r.statusText, msgBn: string | undefined;
      try { const b = (await r.json()) as { message_en?: string; message_bn?: string }; msg = b.message_en ?? msg; msgBn = b.message_bn; } catch {}
      // The refused write's body (patient details, values) is dropped: only what staff need to find it is kept — for a
      // payment, its method and amount (review A6–A7: refused offline cash must stay visible with its amount).
      const b = it.body as { method?: unknown; amountPaisa?: unknown } | null;
      const summary = it.label === "payment" && b && typeof b.method === "string" && Number.isSafeInteger(b.amountPaisa) ? { method: b.method, amountPaisa: b.amountPaisa as number } : undefined;
      save(rest.map((x) => (x.id === it.id ? { ...x, body: null, error: msg, errorBn: msgBn, status: r.status, ...(summary ? { summary } : {}) } : x)));
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
const rawDrafts = (): DeviceDraft[] => draftsMem;
const storeDrafts = (d: DeviceDraft[]) => { draftsMem = d; void persist(); };
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
    at: new Date().toISOString(), ...bi("outbox_draft_expired"), status: 0,
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
      save([...load(), { id: crypto.randomUUID(), owner: d.owner, method: "PUT", path: `/v1/compositions/${d.compositionId}`, body: null, key: d.key, label: "note_draft", at: new Date().toISOString(), ...bi("outbox_draft_damaged"), status: 0 }]);
      continue;
    }
    let r: Response;
    try {
      const path = `/v1/compositions/${encodeURIComponent(d.compositionId)}`;
      r = await fetch("/api" + path, { method: "PUT", credentials: "include", headers: { "content-type": "application/json", "idempotency-key": d.key, ...(await queuedHeaders("PUT", path, d.key)) }, body: JSON.stringify({ ...d.body, rev: d.baseRev }) });
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
