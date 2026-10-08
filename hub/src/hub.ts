// The RSSA reference hub: pulls member feeds, checks membership, policy and signatures in that
// order, merges accepted entries into one group feed, tallies reactions, and speaks WebSub.
//
// This file is the router. Each group is a `Group` (group.ts), which in production lives in its own
// Durable Object (worker.ts). In Node (tests, perf harness) groups run in-process over the injected
// Store. A member index (store.ts) sends each WebSub ping only to the groups that contain it.

import { handleMcpHttp, validate } from "../../packages/sdk-js/src/index.ts";
import { Group, deliver, type DeliveryMessage, type LegacyGroup, type CardState, type Subscription } from "./group.ts";
import { Directory, storeGroupStore, type Store } from "./store.ts";

export type { Store } from "./store.ts";
export { memoryStore } from "./store.ts";

/** What the router needs from a group, wherever it runs. */
export interface GroupHandle {
  init(policyUrl: string): Promise<void>;
  refresh(): Promise<string[]>;
  ping(url: string): Promise<string[]>;
  fetch(req: Request): Promise<Response>;
}

export interface HubConfig {
  /** Hub-wide directory (group list, member index). Also holds the groups' rows when they run in-process. */
  store: Store;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Bearer token for admin routes (register a group, force refresh, import). */
  adminToken?: string;
  /** How long a member's card and keys are trusted before a refetch (spec: 15 minutes). */
  cardTtlMs?: number;
  maxEntries?: number;
  /** Public origin of this hub, e.g. https://hub.example.com. Defaults to the request origin. */
  baseUrl?: string;
  /** Where groups run. Default: in-process, over `store`. worker.ts supplies Durable Objects. */
  group?: (id: string) => GroupHandle;
  /** Runs work after the response (Workers: ctx.waitUntil). Default: awaited before responding. */
  defer?: (p: Promise<unknown>) => void;
  /** The v0.1 KV layout to import groups from (POST /g/<id>/import). */
  legacy?: Store;
  /** Caches the group list between requests (Workers: module scope), so reads don't each cost a KV read. */
  idCache?: { ids?: string[]; at?: number };
}

const j = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export async function groupId(policyUrl: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(policyUrl)));
  return Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ID_CACHE_MS = 60_000;

export class Hub {
  private c: HubConfig & { now: () => number; cardTtlMs: number; maxEntries: number };
  base: string;
  readonly dir: Directory;
  private local = new Map<string, Group>();

  constructor(cfg: HubConfig) {
    this.c = { now: () => Date.now(), cardTtlMs: 15 * 60_000, maxEntries: 500, ...cfg };
    this.base = (cfg.baseUrl ?? "").replace(/\/$/, "");
    this.dir = new Directory(cfg.store);
  }

  /** The in-process Group for `id` (Node). */
  localGroup(id: string): Group {
    let g = this.local.get(id);
    if (!g) {
      g = new Group({
        id, rows: storeGroupStore(this.c.store, id), fetch: this.c.fetch, now: this.c.now, cardTtlMs: this.c.cardTtlMs, maxEntries: this.c.maxEntries,
        base: () => this.base,
        reindex: (gid, before, after) => this.dir.reindex(gid, before, after),
        notify: async (m) => { await this.deliverNow([m]); },
      });
      this.local.set(id, g);
    }
    return g;
  }

  group(id: string): GroupHandle {
    return this.c.group ? this.c.group(id) : this.localGroup(id);
  }

  /** In-process delivery (Node); production hands the same message to a Queue. */
  deliverNow(msgs: DeliveryMessage[]) {
    return deliver(msgs, async (gid) => (await this.group(gid).fetch(new Request(this.groupFeedUrl(gid)))).text(), this.c.fetch, this.base);
  }

  async groupIds(): Promise<string[]> {
    const cache = this.c.idCache;
    if (cache?.ids && this.c.now() - (cache.at ?? 0) < ID_CACHE_MS) return cache.ids;
    const ids = await this.dir.groupIds();
    if (cache) { cache.ids = ids; cache.at = this.c.now(); }
    return ids;
  }

  /** Registers a group by its policy URL. Idempotent. */
  async register(policyUrl: string): Promise<{ id: string; policyUrl: string }> {
    if (!/^https:\/\/\S+$/.test(policyUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(policyUrl)) throw new Error("policy URL must be https");
    const id = await groupId(policyUrl);
    await this.dir.addGroup(id);
    if (this.c.idCache) this.c.idCache.ids = undefined;
    await this.group(id).init(policyUrl);
    return { id, policyUrl };
  }

  refresh(id: string): Promise<string[]> {
    return this.group(id).refresh();
  }

  async refreshAll(): Promise<void> {
    for (const id of await this.dir.groupIds()) {
      try { await this.refresh(id); } catch { /* one bad group must not stop the others */ }
    }
  }

  groupFeedUrl(id: string) { return `${this.base}/g/${id}/feed.atom`; }

  private run(p: Promise<unknown>) {
    const safe = p.catch(() => undefined);
    if (this.c.defer) { this.c.defer(safe); return Promise.resolve(); }
    return safe;
  }

  // ---------------- WebSub ----------------

  async websub(form: URLSearchParams): Promise<Response> {
    const mode = form.get("hub.mode");
    if (mode === "publish") {
      const url = form.get("hub.url") ?? form.get("hub.topic");
      if (!url) return new Response("hub.url required", { status: 400 });
      // One index read, whatever the number of groups (#13). The refresh runs after the response in production.
      const ids = await this.dir.groupsFor(url);
      if (!ids.length) return new Response("not a member feed of any group on this hub", { status: 202 });
      await Promise.all(ids.map((id) => this.run(this.group(id).ping(url))));
      return new Response(null, { status: 204 });
    }
    if (mode === "subscribe" || mode === "unsubscribe") {
      const topic = form.get("hub.topic") ?? "";
      let id: string | undefined;
      try {
        const t = new URL(topic);
        id = /^\/g\/([0-9a-f]{12})\/feed\.atom$/.exec(t.pathname)?.[1];
        if (this.base && t.origin !== new URL(this.base).origin) id = undefined;
      } catch { id = undefined; }
      if (!id || !(await this.groupIds()).includes(id)) return new Response("hub.topic must be a group feed on this hub", { status: 404 });
      return this.group(id).fetch(new Request(`${this.base}/g/${id}/websub`, { method: "POST", body: form.toString() }));
    }
    return new Response("hub.mode must be publish, subscribe or unsubscribe", { status: 400 });
  }

  // ---------------- HTTP ----------------

  private authorised(req: Request) {
    return !!this.c.adminToken && req.headers.get("authorization") === `Bearer ${this.c.adminToken}`;
  }

  private async legacyFor(id: string): Promise<LegacyGroup> {
    const kv = this.c.legacy ?? this.c.store;
    const get = async <T>(k: string) => { const v = await kv.get(k); return v ? (JSON.parse(v) as T) : undefined; };
    const state = await get<{ members?: Record<string, unknown> }>(`group:${id}`);
    if (!state) throw new Error(`no legacy state group:${id}`);
    const cards: Record<string, CardState | undefined> = {};
    for (const feed of Object.keys(state.members ?? {})) cards[feed] = await get<CardState>(`card:${feed}`);
    return { state, cards, subs: (await get<Subscription[]>(`subs:${this.groupFeedUrl(id)}`)) ?? [], readers: (await get<Record<string, number>>(`readers:${id}`)) ?? {} };
  }

  async handle(req: Request): Promise<Response> {
    if (req.method === "HEAD") {
      // Feed readers probe with HEAD: answer as GET, without the body.
      const r = await this.handle(new Request(req.url, { method: "GET", headers: req.headers }));
      return new Response(null, { status: r.status, headers: r.headers });
    }
    const url = new URL(req.url);
    if (!this.base) this.base = url.origin;
    const path = url.pathname;
    try {
      if (req.method === "POST" && (path === "/" || path === "/hub")) {
        if (Number(req.headers.get("content-length") ?? 0) > 8192) return new Response("too large", { status: 413 });
        return this.websub(new URLSearchParams(await req.text()));
      }
      if (req.method === "GET" && path === "/") {
        return j({ name: "RSSA reference hub", version: "0.2.0", spec: "https://github.com/getvda-ai/rssa", groups: (await this.groupIds()).map((id) => `${url.origin}/g/${id}/`), websub: `${url.origin}/`, validate: `${url.origin}/validate?url=`, mcp: `${url.origin}/mcp` });
      }
      if (path === "/mcp") {
        // MCP endpoint (a reference-hub extra, not part of the protocol): read, verify and validate
        // feeds and groups from any MCP client. The hub's own URLs are answered in-process.
        const fetcher = (u: string, i?: RequestInit) => (u.startsWith(`${url.origin}/`) ? this.handle(new Request(u, i)) : this.c.fetch(u, i));
        return handleMcpHttp(req, { fetcher });
      }
      if (req.method === "GET" && path === "/validate") {
        const target = url.searchParams.get("url");
        if (!target || !/^https:\/\//.test(target)) return j({ error: "pass ?url=https://… (an Agent Card, feed or group policy)" }, 400);
        // A Worker cannot fetch its own hostname (Cloudflare returns 522), so the hub's own URLs are answered in-process.
        const fetcher = (u: string, i?: RequestInit) => (u.startsWith(`${url.origin}/`) ? this.handle(new Request(u, i)) : this.c.fetch(u, i));
        return j(await validate(target, { fetcher }), 200, { "access-control-allow-origin": "*" });
      }
      if (req.method === "POST" && path === "/groups") {
        if (!this.authorised(req)) return j({ error: "admin token required" }, 401);
        const { policy } = (await req.json()) as { policy: string };
        const g = await this.register(policy);
        await this.refresh(g.id);
        return j({ id: g.id, feed: this.groupFeedUrl(g.id), status: `${url.origin}/g/${g.id}/status.json` }, 201);
      }
      const m = /^\/g\/([0-9a-f]{12})\/(feed\.atom|roster\.opml|reactions\.json|status\.json|refresh|join|import)?$/.exec(path);
      if (m) {
        const [, id, leaf] = m;
        if (leaf === "refresh" || leaf === "import") {
          if (req.method !== "POST") return j({ error: "not found" }, 404);
          if (!this.authorised(req)) return j({ error: "admin token required" }, 401);
        }
        // Unknown ids never reach a group (in production, that would create a Durable Object).
        if (!(await this.groupIds()).includes(id)) return j({ error: "unknown group" }, 404);
        if (leaf === "import") {
          return this.group(id).fetch(new Request(`${this.base}/g/${id}/import`, { method: "POST", body: JSON.stringify(await this.legacyFor(id)) }));
        }
        return this.group(id).fetch(req);
      }
      return j({ error: "not found" }, 404);
    } catch (e) {
      return j({ error: (e as Error).message }, 500);
    }
  }
}
