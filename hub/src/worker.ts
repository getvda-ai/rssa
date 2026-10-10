// Cloudflare Workers entry point for the RSSA reference hub (v0.2, docs/HUB-ARCHITECTURE.md).
// - fetch: a stateless router (hub.ts) in front of one Durable Object per group, with per-IP rate limits.
// - GroupDO: one group's rows in SQLite; its own alarm polls member feeds every 5 minutes.
// - queue: WebSub delivery, one message per refresh that accepted something (no DO wall time spent on subscribers).
// - scheduled (hourly): registers GROUPS and re-arms any group whose alarm is missing.

import { DurableObject } from "cloudflare:workers";
import { Hub, groupId, type GroupHandle } from "./hub.ts";
import { Group, deliver, type DeliveryMessage } from "./group.ts";
import { Directory, MAX_ROW_BYTES, type GroupStore, type Store } from "./store.ts";

export interface Env {
  RSSA: KVNamespace;
  GROUP: DurableObjectNamespace<GroupDO>;
  DELIVERY: Queue<DeliveryMessage>;
  LIMIT_WRITE?: RateLimit;
  LIMIT_READ?: RateLimit;
  HUB_ADMIN_TOKEN?: string;
  HUB_URL?: string;
  /** Comma-separated policy URLs registered by the hourly cron (optional; POST /groups also works). */
  GROUPS?: string;
}

const POLL_MS = 5 * 60_000;
/** Every outbound fetch has a timeout: a pending fetch keeps a Durable Object billed for up to 15 minutes. */
const FETCH_TIMEOUT_MS = 15_000;
const timedFetch = (u: string, i?: RequestInit) => fetch(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });

const kv = (ns: KVNamespace): Store => ({
  get: (k) => ns.get(k),
  put: (k, v) => ns.put(k, v),
  delete: (k) => ns.delete(k),
});
const base = (env: Env) => (env.HUB_URL ?? "").replace(/\/$/, "");

function sqlRows(ctx: DurableObjectState): GroupStore {
  const sql = ctx.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS r (t TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (t, k)) WITHOUT ROWID");
  return {
    async get(t, k) {
      const row = sql.exec<{ v: string }>("SELECT v FROM r WHERE t = ? AND k = ?", t, k).toArray()[0];
      return row ? row.v : null;
    },
    async list(t) {
      return sql.exec<{ k: string; v: string }>("SELECT k, v FROM r WHERE t = ?", t).toArray().map((r) => [r.k, r.v] as [string, string]);
    },
    async write(puts, dels) {
      ctx.storage.transactionSync(() => {
        for (const [t, k, v] of puts) {
          if (v.length > MAX_ROW_BYTES) throw new Error(`row ${t}:${k} is ${v.length} bytes; limit ${MAX_ROW_BYTES}`);
          sql.exec("INSERT OR REPLACE INTO r (t, k, v) VALUES (?, ?, ?)", t, k, v);
        }
        for (const [t, k] of dels) sql.exec("DELETE FROM r WHERE t = ? AND k = ?", t, k);
      });
    },
  };
}

/** One group. Its id is the name the router addressed it by (idFromName). */
export class GroupDO extends DurableObject<Env> {
  private rows: GroupStore;
  private g?: Group;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.rows = sqlRows(ctx);
  }

  private group(id: string): Group {
    if (this.g && this.g.id === id) return this.g;
    return (this.g = new Group({
      id, rows: this.rows, fetch: timedFetch, now: () => Date.now(), cardTtlMs: 15 * 60_000, maxEntries: 500,
      base: () => base(this.env),
      reindex: (gid, before, after) => new Directory(kv(this.env.RSSA)).reindex(gid, before, after),
      notify: async (m) => { await this.env.DELIVERY.send(m); },
      soon: (ms) => this.armSoon(ms),
    }));
  }

  /** Brings the alarm forward to within `ms` (never pushes it back). */
  private async armSoon(ms: number) {
    const at = Date.now() + ms;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  /** When the last full poll ran (in memory: after an eviction the next alarm polls in full). */
  private lastFull = 0;

  /** Alarms only, never timers: an object with a pending timer cannot hibernate and is billed while idle. */
  private async arm(delayMs = POLL_MS) {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  async init(id: string, policyUrl: string) { await this.group(id).init(policyUrl); await this.arm(1000); }
  async refresh(id: string) { const r = await this.group(id).refresh(); await this.arm(); return r; }
  async ping(id: string, url: string) { const r = await this.group(id).ping(url); await this.arm(); return r; }
  async ensure(id: string) { if (await this.group(id).exists()) await this.arm(); }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = /^\/g\/([0-9a-f]{12})(\/|$)/.exec(url.pathname)?.[1];
    if (!id) return new Response("not found", { status: 404 });
    const r = await this.group(id).fetch(req);
    if (req.method === "POST" && r.ok && url.pathname.endsWith("/import")) await this.arm(1000);
    return r;
  }

  async alarm() {
    const meta = await this.rows.get("meta", "");
    if (!meta) return;
    const g = this.group((JSON.parse(meta) as { id: string }).id);
    // An early wake-up for debounced pings refetches only those URLs; the full poll keeps its own rhythm.
    let flushed = false;
    try { flushed = await g.flushTrailing(); } catch { /* the full poll below or the next one catches up */ }
    if (!flushed || Date.now() - this.lastFull >= POLL_MS - 1000) {
      try { await g.refresh(); } catch { /* recorded on the group; next poll retries */ }
      this.lastFull = Date.now();
    }
    await this.ctx.storage.setAlarm(Math.max(this.lastFull + POLL_MS, Date.now() + 1000));
  }
}

const groupHandle = (env: Env) => (id: string): GroupHandle => {
  const stub = env.GROUP.get(env.GROUP.idFromName(id));
  return {
    init: (p) => stub.init(id, p),
    refresh: () => stub.refresh(id),
    ping: (u) => stub.ping(id, u),
    fetch: (r) => stub.fetch(r),
  };
};

/** Survives between requests in one isolate, so a read does not pay a KV read for the group list. */
const idCache: { ids?: string[]; at?: number } = {};

const hub = (env: Env, ctx?: ExecutionContext) => new Hub({
  store: kv(env.RSSA), fetch: timedFetch, adminToken: env.HUB_ADMIN_TOKEN, baseUrl: env.HUB_URL,
  group: groupHandle(env), defer: ctx ? (p) => ctx.waitUntil(p) : undefined, legacy: kv(env.RSSA), idCache,
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Budget guard: per-IP limits on writes (pings, subscriptions, /validate fetches) and on reads.
    const path = new URL(req.url).pathname;
    const limiter = req.method === "POST" || path === "/validate" ? env.LIMIT_WRITE : env.LIMIT_READ;
    if (limiter && !(await limiter.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" })).success) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
    }
    return hub(env, ctx).handle(req);
  },

  async queue(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
    const g = groupHandle(env);
    await deliver(batch.messages.map((m) => m.body), async (gid) => (await g(gid).fetch(new Request(`${base(env)}/g/${gid}/feed.atom`))).text(), timedFetch, base(env));
    batch.ackAll();
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const h = hub(env);
      const known = await h.dir.groupIds();
      // Only new groups are created here; an existing id (e.g. one awaiting import from v0.1) is left alone.
      for (const p of (env.GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!known.includes(await groupId(p))) await h.register(p);
      }
      for (const id of await h.dir.groupIds()) {
        try { await env.GROUP.get(env.GROUP.idFromName(id)).ensure(id); } catch { /* next hour */ }
      }
    })());
  },
} satisfies ExportedHandler<Env, DeliveryMessage>;

