/* Short-lived counters and locks shared by every API instance (external review A3, HANDOVER gap 4): login failures,
   the per-user login lock, signing-PIN tries. Redis (REDIS_URL — production refuses to start without it); in development
   without Redis an in-memory store (one process only). Keys expire on their own. */
import { Redis } from "ioredis";
import { config } from "../config.js";

export interface Counters {
  /** add one; the window starts with the first count and is not extended by later ones */
  incr(key: string, windowMs: number): Promise<number>;
  get(key: string): Promise<number>;
  /** milliseconds left on a key, 0 when absent */
  ttlMs(key: string): Promise<number>;
  set(key: string, value: number, ttlMs: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** staging (/ready): the store answers */
  ping(): Promise<boolean>;
}

class RedisCounters implements Counters {
  constructor(private r: Redis) {}
  async incr(key: string, windowMs: number) {
    const [[, n]] = (await this.r.multi().incr(key).pexpire(key, windowMs, "NX").exec()) as [[unknown, number], unknown];
    return n;
  }
  async get(key: string) { return Number((await this.r.get(key)) ?? 0); }
  async ttlMs(key: string) { return Math.max(0, await this.r.pttl(key)); }
  async set(key: string, value: number, ttlMs: number) { await this.r.set(key, String(value), "PX", ttlMs); }
  async del(...keys: string[]) { if (keys.length) await this.r.del(...keys); }
  async ping() { try { return (await this.r.ping()) === "PONG"; } catch { return false; } }
}

class MemoryCounters implements Counters {
  private m = new Map<string, { n: number; until: number }>();
  private live(key: string) { const x = this.m.get(key); if (x && x.until <= Date.now()) { this.m.delete(key); return undefined; } return x; }
  async incr(key: string, windowMs: number) { const x = this.live(key) ?? { n: 0, until: Date.now() + windowMs }; x.n += 1; this.m.set(key, x); return x.n; }
  async get(key: string) { return this.live(key)?.n ?? 0; }
  async ttlMs(key: string) { const x = this.live(key); return x ? x.until - Date.now() : 0; }
  async set(key: string, value: number, ttlMs: number) { this.m.set(key, { n: value, until: Date.now() + ttlMs }); }
  async del(...keys: string[]) { for (const k of keys) this.m.delete(k); }
  async ping() { return true; }
}

let store: Counters | null = null;
let client: Redis | null = null;
export function counters(): Counters {
  if (store) return store;
  if (config.redisUrl) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
    client.on("error", (e) => console.error("redis:", e.message));
    store = new RedisCounters(client);
  } else store = new MemoryCounters();
  return store;
}
/** Close the connection (app shutdown, tests). */
export async function closeCounters() { if (client) { await client.quit().catch(() => undefined); client = null; store = null; } }
