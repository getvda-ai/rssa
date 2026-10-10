// One RSS-A group: its state, its refresh, its WebSub subscribers and its read routes.
// In production each Group lives in its own Durable Object (worker.ts), which makes it the single
// writer for that group (#9). In Node it runs in-process over a Store (hub.ts). Platform-neutral:
// rows, fetch, the clock, the member index and delivery are injected.
//
// Writes are diffs: only rows whose value changed are written, so a refresh that finds nothing new
// writes one row (the meta row's refreshedAt). Reads are lazy: a 304 reads one row.

import {
  HEARTBEAT, PostLedger, USER_AGENT, atomXml, cadenceProblem, checkContinuity, checkEntry, durationMs, effectiveSettings, findRssa,
  cardModules, liveness, parseFeed, resolveKeys, rosterOpml, strictParse, thumbprint, verifyEntry, verifyPolicy,
  type GroupPolicy, type PublicJwk, type RotationStatement, type RssaEntry, type Settings,
} from "../../packages/sdk-js/src/index.ts";
import type { GroupStore } from "./store.ts";

export const LIMITS = { payload: 4096, summary: 2000, content: 65536, feedBytes: 2_000_000 };
/** Byte budget for the retained entries (#12): it bounds the merged feed every reader downloads. */
export const ENTRY_BYTES = 10 * 1024 * 1024;
/** Concurrent member-feed fetches per refresh (a Worker may wait on 6 connections at once). */
export const FETCH_POOL = 6;
/** The merged feed is stored in chunks well under the 2 MB row limit (4 bytes per char at worst). */
const XML_CHUNK = 450_000;
/** Bounds WebSub fan-out per group (budget guard). */
export const MAX_SUBSCRIBERS = 100;
const REJECTED_LOG = 100;
/**
 * Hub budget guard, by the hub's own clock (non-normative): at most this many accepted entries,
 * edits and reactions per member per hour. The rest wait for the next hour. It stops a member
 * backdating a flood past the group's caps, and bounds writes and signature checks per member.
 */
export const MEMBER_BUDGET = 120;
const BUDGET_WINDOW_MS = 3_600_000;
/** A heartbeat is absorbed at most this often per member; faster ones wait (write budget). */
export const HEARTBEAT_MIN_MS = 5 * 60_000;
/** Pings for one URL closer together than this are dropped; the next ping or the poll picks the change up. */
export const PING_GAP_MS = 10_000;
/** Liveness slack: the hub polls every 5 minutes, so a signal can reach it up to one poll late. */
export const LIVENESS_SLACK_MS = 10 * 60_000;
const IDENTITY_HISTORY = 20;
const TRUSTED_KEYS = 20;

export interface CardState {
  feed: string;
  cardUrl: string;
  keys: PublicJwk[];
  groups: string[];
  modules: string[];
  fetchedAt: number;
  /** Set when the last refetch failed and we are running on the cached copy (identity grace). */
  staleSince?: number;
  /** Set when the keys changed without a rotation statement or owner pin. */
  keyChangedAt?: number;
  /** Declared params.cadence. */
  cadence?: string;
  /** The card's rotation statements (sign.md §9), kept to re-evaluate when the owner's pins change. */
  rotations?: RotationStatement[];
  /** Thumbprints of `keys`, in order. */
  thumbs?: string[];
  /** Keys this hub trusts for the member: first seen, announced by a statement, pinned, or (under record) accepted. */
  trusted?: PublicJwk[];
  /** Thumbprints in the card with no statement or pin. Under keyContinuity hold, their posts are held. */
  unannounced?: string[];
  /** Keys that announced two different successors. */
  forks?: string[];
  /** Each key's announced successor, remembered so a later contradicting statement is a fork. */
  seen?: Record<string, string>;
  /** The pins this state was computed with (sorted, comma-joined). */
  pins?: string;
  /** The identity log: each change of the member's key set, newest last. */
  history?: IdentityEvent[];
}
export interface IdentityEvent { at: number; keys: string[]; change: "first" | "rotated" | "pinned" | "unannounced" | "held" | "fork" }
/** Facts the hub keeps per member (members.json). No score. */
export interface Track { firstSeen: number; accepted: number; edits: number; heartbeats: number; rejected: Record<string, number> }
export interface StoredEntry extends RssaEntry { acceptedAt: number; depth: number; root: string }
export interface MemberStatus {
  feed: string; ok: boolean; problem?: string; etag?: string; lastModified?: string;
  /** Entries waiting (future-dated or over the hub budget): the feed is refetched without a conditional GET until they clear. */
  held?: number;
  /** Hub budget window: its start and the entries accepted in it. */
  budget?: { start: number; n: number };
  /** Latest signal (entry or heartbeat `updated`, capped at the hub's clock). */
  lastSignal?: number;
  lastHeartbeatAt?: number;
  track?: Track;
}
export interface Subscription { callback: string; topic: string; secret?: string; expires: number; createdAt: number }
interface Rejection { id: string; feed: string; at: number; reasons: string[] }

/** The group's small, always-loaded row. */
interface Meta {
  id: string;
  policyUrl: string;
  policy?: GroupPolicy;
  policyProblem?: string;
  /** Feeds that joined an open group through POST /g/:id/join. */
  joined: string[];
  rejected: Rejection[];
  /** Tallies per target id, derived from the `react` rows (never incremented directly). */
  reactions: Record<string, Record<string, number>>;
  /** When the group is at capacity: the updated time of the oldest retained entry (only moves forward). */
  floor?: string;
  refreshedAt?: number;
  feedEtag?: string;
  xmlChunks?: number;
  /** URLs this group currently has in the hub's member index. */
  indexed: string[];
}

/** Everything a refresh needs; loaded on first use. Each field is one table, keyed by id or feed. */
interface Full {
  members: Record<string, MemberStatus>;
  cards: Record<string, CardState>;
  entries: StoredEntry[];
  /** Entries decided without being stored (rejected or tallied). Re-reads skip them until they change. */
  decided: Record<string, { updated: string; feed?: string }>;
  /** Entries rejected on their signature, with the member's key set at the time: re-checked when either changes (#10). */
  sigrej: Record<string, { updated: string; keys: string; feed?: string }>;
  /** Each reaction entry's current value, so re-reading a feed cannot double-count (#8). */
  react: Record<string, { target: string; reaction: string }>;
}

export interface DeliveryMessage { group: string; topic: string; etag: string; subs: Array<{ callback: string; secret?: string }> }

export interface GroupConfig {
  id: string;
  rows: GroupStore;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  cardTtlMs: number;
  maxEntries: number;
  base: () => string;
  /** Updates the hub's member index (#13). */
  reindex?: (id: string, before: string[], after: string[]) => Promise<void>;
  /** Hands new content to delivery (a Queue in production). */
  notify?: (m: DeliveryMessage) => Promise<void>;
}

const TABLES = ["member", "card", "entry", "decided", "sigrej", "react"] as const;

const j = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export async function hmacHex(secret: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  return Array.from(s, (b) => b.toString(16).padStart(2, "0")).join("");
}

const strip = ({ acceptedAt: _a, depth: _d, root: _r, ...e }: StoredEntry): RssaEntry => e;

export class Group {
  private meta?: Meta;
  private full?: Full;
  private subs?: Record<string, Subscription>;
  private xml?: { etag: string; body: string };
  /** What is in storage, per table: key -> JSON (or the entry object itself, for entries). */
  private saved = new Map<string, Map<string, unknown>>();
  private chain: Promise<unknown> = Promise.resolve();
  private pendingPings = new Map<string, Promise<string[]>>();
  private lastFetch = new Map<string, number>();
  private lastPing = new Map<string, number>();
  /** Counters for tests and the perf harness. */
  readonly stats = { refreshes: 0 };

  private c: GroupConfig;
  constructor(c: GroupConfig) { this.c = c; }

  get id() { return this.c.id; }
  private feedUrl() { return `${this.c.base()}/g/${this.c.id}/feed.atom`; }

  /** Runs `fn` after every earlier mutation of this group has finished: one refresh at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private table(t: string) {
    let m = this.saved.get(t);
    if (!m) this.saved.set(t, (m = new Map()));
    return m;
  }

  // ---------------- loading and saving ----------------

  private async loadMeta(): Promise<Meta | undefined> {
    if (this.meta) return this.meta;
    const v = await this.c.rows.get("meta", "");
    if (!v) return undefined;
    this.table("meta").set("", v);
    return (this.meta = JSON.parse(v) as Meta);
  }

  private async loadFull(): Promise<Full> {
    if (this.full) return this.full;
    const f: Full = { members: {}, cards: {}, entries: [], decided: {}, sigrej: {}, react: {} };
    for (const t of TABLES) {
      const saved = this.table(t);
      for (const [k, v] of await this.c.rows.list(t)) {
        const o = JSON.parse(v);
        if (t === "entry") { f.entries.push(o); saved.set(k, o); continue; }
        saved.set(k, v);
        (f[t === "member" ? "members" : t === "card" ? "cards" : t] as Record<string, unknown>)[k] = o;
      }
    }
    f.entries.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    return (this.full = f);
  }

  private async loadSubs(): Promise<Record<string, Subscription>> {
    if (this.subs) return this.subs;
    const s: Record<string, Subscription> = {};
    const saved = this.table("sub");
    for (const [k, v] of await this.c.rows.list("sub")) { s[k] = JSON.parse(v); saved.set(k, v); }
    return (this.subs = s);
  }

  /** Writes the rows that differ from storage, in one atomic batch. */
  private async commit(extra: Array<[string, string, string]> = [], extraDels: Array<[string, string]> = []) {
    const puts: Array<[string, string, string]> = [...extra];
    const dels: Array<[string, string]> = [...extraDels];
    const after: Array<() => void> = [];
    const sync = (t: string, cur: Record<string, unknown>, byRef = false) => {
      const saved = this.table(t);
      for (const [k, v] of Object.entries(cur)) {
        const prev = saved.get(k);
        if (byRef ? prev === v : false) continue;
        const s = JSON.stringify(v);
        if (!byRef && prev === s) continue;
        puts.push([t, k, s]);
        after.push(() => saved.set(k, byRef ? v : s));
      }
      for (const k of saved.keys()) if (!(k in cur)) { dels.push([t, k]); after.push(() => saved.delete(k)); }
    };
    if (this.meta) sync("meta", { "": this.meta });
    if (this.full) {
      const f = this.full;
      sync("member", f.members); sync("card", f.cards); sync("decided", f.decided); sync("sigrej", f.sigrej); sync("react", f.react);
      sync("entry", Object.fromEntries(f.entries.map((e) => [e.id, e])), true);
    }
    if (this.subs) sync("sub", this.subs);
    if (!puts.length && !dels.length) return;
    await this.c.rows.write(puts, dels);
    for (const a of after) a();
  }

  // ---------------- lifecycle ----------------

  /** Creates the group if it does not exist. Idempotent. */
  init(policyUrl: string): Promise<void> {
    return this.serial(async () => {
      if (await this.loadMeta()) return;
      this.meta = { id: this.c.id, policyUrl, joined: [], rejected: [], reactions: {}, indexed: [] };
      await this.loadFull();
      await this.commit();
    });
  }

  async exists() { return !!(await this.loadMeta()); }

  /** Full poll: the policy and every member feed (conditional GETs). Returns ids of newly accepted entries. */
  refresh(): Promise<string[]> {
    return this.serial(() => this.doRefresh({}));
  }

  /**
   * A WebSub ping for a member feed, card or the policy. Refetches only what was pinged (a policy
   * ping is a full poll). Pings that arrive while one is queued for the same URL share it.
   */
  ping(url: string): Promise<string[]> {
    const queued = this.pendingPings.get(url);
    if (queued) return queued;
    // Debounce: a burst of pings for one URL costs one refetch (anyone can ping a member's URL).
    const t = this.c.now();
    if (t - (this.lastPing.get(url) ?? -Infinity) < PING_GAP_MS) return Promise.resolve([]);
    this.lastPing.set(url, t);
    const p = this.serial(async () => {
      this.pendingPings.delete(url);
      const m = await this.loadMeta();
      if (!m) return [];
      if (url === m.policyUrl) return this.doRefresh({});
      const f = await this.loadFull();
      if (f.members[url]) return this.doRefresh({ only: url });
      const byCard = Object.values(f.cards).find((c) => c.cardUrl === url);
      if (byCard && f.members[byCard.feed]) return this.doRefresh({ only: byCard.feed, forceCard: true });
      return [];
    });
    this.pendingPings.set(url, p);
    return p;
  }

  // ---------------- member cards and keys ----------------

  private async card(feed: string, cardUrl: string | undefined, settings: Settings, force = false, pins: string[] = []): Promise<CardState | { error: string }> {
    const f = this.full!;
    const cached = f.cards[feed];
    const now = this.c.now();
    if (cached && !force && now - cached.fetchedAt < this.c.cardTtlMs && (!cardUrl || cached.cardUrl === cardUrl)) {
      // The owner changed this member's pins: re-evaluate the cached card against them.
      if ((cached.pins ?? "") !== [...pins].sort().join(",")) await this.continuity(cached, { ...cached }, pins, settings, now);
      return cached;
    }
    const url = cardUrl ?? cached?.cardUrl;
    if (!url) return { error: "feed has no rel=describedby link to its Agent Card" };
    try {
      const r = await this.c.fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
      if (!r.ok) throw new Error(`card GET returned ${r.status}`);
      const card = await r.json();
      const ext = findRssa(card);
      if (!ext) return { error: `card ${url} has no RSSA extension` };
      if (ext.params.feed !== feed) return { error: `card ${url} names feed ${ext.params.feed}, not ${feed}` };
      const keys = ext.params.keys ? await resolveKeys(ext.params.keys, this.c.fetch) : [];
      const p = ext.params as unknown as Record<string, unknown>;
      const next: CardState = {
        feed, cardUrl: url, keys, groups: ext.params.groups ?? [], modules: cardModules(card), fetchedAt: now,
        cadence: typeof p.cadence === "string" ? p.cadence : undefined,
        rotations: Array.isArray(p.rotations) ? (p.rotations as RotationStatement[]).slice(0, 50) : undefined,
      };
      await this.continuity(next, cached, pins, settings, now);
      f.cards[feed] = next;
      return next;
    } catch (e) {
      // Identity grace: keep using the last known good card (and only its keys) for a while.
      if (cached) {
        const staleSince = cached.staleSince ?? now;
        if (now - staleSince <= durationMs(settings.identityGrace)) {
          const s = { ...cached, staleSince };
          f.cards[feed] = s;
          return s;
        }
        return { error: `card unreachable since ${new Date(staleSince).toISOString()} (beyond identityGrace ${settings.identityGrace}); posts held: ${(e as Error).message}` };
      }
      return { error: `cannot fetch card: ${(e as Error).message}` };
    }
  }

  /**
   * Key continuity (sign.md §9): which of the card's keys this hub trusts, and the identity log.
   * The first card seen is trusted (TOFU). After that a new key needs a rotation statement from a
   * trusted key, or an owner pin; otherwise it is recorded (keyContinuity record) or held (hold).
   */
  private async continuity(next: CardState, prev: CardState | undefined, pins: string[], s: Settings, now: number) {
    const pub = (k: PublicJwk): PublicJwk => ({ kty: "OKP", crv: "Ed25519", x: k.x });
    next.thumbs = await Promise.all(next.keys.map((k) => thumbprint(k)));
    next.pins = [...pins].sort().join(",");
    next.history = [...(prev?.history ?? [])];
    next.seen = { ...(prev?.seen ?? {}) };
    const log = (change: IdentityEvent["change"]) => {
      next.history!.push({ at: now, keys: next.thumbs!, change });
      next.history = next.history!.slice(-IDENTITY_HISTORY);
    };
    // Cards cached before continuity existed: their keys are the trusted set (no alarm on upgrade).
    const before = prev?.trusted ?? prev?.keys ?? [];
    if (!before.length) {
      next.trusted = next.keys.map(pub);
      next.unannounced = [];
      next.forks = [];
      if (!next.history.length) log("first");
      return;
    }
    const c = await checkContinuity({ cardUrl: next.cardUrl, trusted: before, current: next.keys, rotations: next.rotations, pins, seen: prev?.seen });
    for (const e of c.edges) if (!c.forks.includes(e.prev)) next.seen[e.prev] ??= e.next;
    const trusted = new Map<string, PublicJwk>();
    for (const k of c.trusted) trusted.set(await thumbprint(k), pub(k));
    // Under record, a silent change is accepted (and logged); under hold, it is not trusted.
    if (s.keyContinuity !== "hold") next.keys.forEach((k, i) => trusted.set(next.thumbs![i], pub(k)));
    // Bound the set, always keeping the card's current keys.
    const cur = new Set(next.thumbs);
    const others = [...trusted].filter(([t]) => !cur.has(t)).slice(-Math.max(0, TRUSTED_KEYS - cur.size));
    next.trusted = [...[...trusted].filter(([t]) => cur.has(t)), ...others].map(([, k]) => k);
    next.unannounced = s.keyContinuity === "hold" ? c.unannounced : [];
    next.forks = c.forks;
    const beforeThumbs = new Set(await Promise.all(before.map((k) => thumbprint(k))));
    const prevThumbs = prev?.thumbs ?? (await Promise.all((prev?.keys ?? []).map((k) => thumbprint(k))));
    const keysChanged = [...prevThumbs].sort().join() !== [...next.thumbs].sort().join();
    const newFork = c.forks.some((x) => !(prev?.forks ?? []).includes(x));
    const newKeys = next.thumbs.filter((t) => !beforeThumbs.has(t));
    const viaPin = newKeys.length > 0 && newKeys.every((t) => pins.includes(t));
    if (newFork) log("fork");
    else if (keysChanged) log(c.unannounced.length ? (s.keyContinuity === "hold" ? "held" : "unannounced") : viaPin ? "pinned" : "rotated");
    else if (prev?.unannounced?.length && !next.unannounced.length) log(prev.unannounced.every((t) => pins.includes(t)) ? "pinned" : "rotated");
    if (keysChanged && c.unannounced.length) next.keyChangedAt = now;
    else if (!keysChanged) next.keyChangedAt = prev?.keyChangedAt;
  }

  /** The keys posts are verified with: the card's keys, minus any held under keyContinuity hold. */
  private verifyKeys(c: CardState): PublicJwk[] {
    if (!c.unannounced?.length) return c.keys;
    return c.keys.filter((_, i) => !c.unannounced!.includes(c.thumbs?.[i] ?? ""));
  }

  // ---------------- refresh ----------------

  private async doRefresh(opts: { only?: string; forceCard?: boolean }): Promise<string[]> {
    const m = await this.loadMeta();
    if (!m) throw new Error(`unknown group ${this.c.id}`);
    const f = await this.loadFull();
    const now = this.c.now();
    this.stats.refreshes++;

    // 1. Policy: the group's single source of truth. A bad new version never replaces a good one.
    // Reloaded on every full poll; a ping for one member reuses the loaded policy.
    if (!opts.only || !m.policy) {
      try {
        const r = await this.c.fetch(m.policyUrl, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
        if (!r.ok) throw new Error(`policy GET returned ${r.status}`);
        const p = strictParse(await r.text()) as unknown as GroupPolicy;
        const settings = effectiveSettings(p);
        const v = await verifyPolicy(p, this.c.fetch);
        if (!v.ok && (settings.signatures === "required" || p.preset !== "open")) throw new Error(`policy signature: ${v.error}`);
        if (m.policy && p.version < m.policy.version) throw new Error(`policy version ${p.version} is older than ${m.policy.version}; keeping the newer one`);
        m.policy = p;
        m.policyProblem = v.ok ? undefined : `unsigned policy accepted because the preset is open (${v.error})`;
      } catch (e) {
        m.policyProblem = (e as Error).message;
        if (!m.policy) { m.refreshedAt = now; await this.commit(); return []; }
      }
    }
    const policy = m.policy!;
    const s = effectiveSettings(policy);
    const groupRef = [policy.group, m.policyUrl];
    const allFeeds = [...new Set([...policy.members.map((x) => x.feed), ...(s.membership === "open" ? m.joined : [])])];
    if (!opts.only) {
      // Members removed from the policy leave the status and the card cache.
      for (const k of Object.keys(f.members)) if (!allFeeds.includes(k)) delete f.members[k];
      for (const k of Object.keys(f.cards)) if (!allFeeds.includes(k)) delete f.cards[k];
    }
    const feeds = opts.only ? allFeeds.filter((x) => x === opts.only) : allFeeds;

    // Thread context and post counts from what the group already holds.
    const depth = new Map(f.entries.map((e) => [e.id, e.depth]));
    const root = new Map(f.entries.map((e) => [e.id, e.root]));
    const last = new Map<string, number>();
    const ledger = new PostLedger();
    for (const e of f.entries) {
      const k = `${e.sourceFeed} ${e.root}`;
      last.set(k, Math.max(last.get(k) ?? 0, Date.parse(e.updated)));
      if (e.type !== "reaction") ledger.add(e.sourceFeed ?? "", Date.parse(e.updated));
    }
    const known = new Map(f.entries.map((e) => [e.id, e]));
    const accepted: string[] = [];
    const { decided, sigrej, react } = f;
    let reactionsChanged = false;
    const floor = m.floor ? Date.parse(m.floor) : undefined;
    const track = (st: MemberStatus) => (st.track ??= { firstSeen: now, accepted: 0, edits: 0, heartbeats: 0, rejected: {} });
    const count = (st: MemberStatus, codes: string[]) => { const t = track(st); for (const c of new Set(codes)) t.rejected[c] = (t.rejected[c] ?? 0) + 1; };
    const logRejection = (r: Rejection) => {
      m.rejected.unshift(r);
      m.rejected = m.rejected.slice(0, REJECTED_LOG);
    };
    const reject = (e: RssaEntry, feed: string, reasons: string[], codes: string[]) => {
      decided[e.id] = { updated: e.updated, feed };
      logRejection({ id: e.id, feed, at: now, reasons });
      count(f.members[feed], codes);
    };
    // A feed holding posts rejected on their signature is fetched without a conditional GET once its
    // card is due for a refetch, so a key rotation reaches those posts even if the feed itself is unchanged.
    // So is a feed with held posts (future-dated or over the hub budget), so they are seen again.
    const sigrejFeeds = new Set(Object.values(sigrej).map((x) => x.feed));
    const unconditional = (feed: string) =>
      (opts.forceCard && feed === opts.only) || !!f.members[feed]?.held ||
      (sigrejFeeds.has(feed) && (!f.cards[feed] || now - f.cards[feed].fetchedAt >= this.c.cardTtlMs));

    // Fetch member feeds concurrently (pool of FETCH_POOL).
    const bodies = new Map<string, string | undefined>();
    const queue = [...feeds];
    await Promise.all(Array.from({ length: Math.min(FETCH_POOL, queue.length) }, async () => {
      for (let feed = queue.shift(); feed !== undefined; feed = queue.shift()) {
        const st: MemberStatus = f.members[feed] ?? { feed, ok: false };
        f.members[feed] = st;
        try {
          const headers: Record<string, string> = { "user-agent": USER_AGENT };
          if (!unconditional(feed)) {
            if (st.etag) headers["if-none-match"] = st.etag;
            if (st.lastModified) headers["if-modified-since"] = st.lastModified;
          }
          const r = await this.c.fetch(feed, { headers });
          this.lastFetch.set(feed, now);
          if (r.status === 304) { st.ok = true; bodies.set(feed, undefined); continue; }
          if (!r.ok) throw new Error(`feed GET returned ${r.status}`);
          const body = await r.text();
          if (body.length > LIMITS.feedBytes) throw new Error(`feed is ${body.length} bytes; limit ${LIMITS.feedBytes}`);
          st.etag = r.headers.get("etag") ?? undefined;
          st.lastModified = r.headers.get("last-modified") ?? undefined;
          bodies.set(feed, body);
        } catch (e) {
          st.ok = false;
          st.problem = (e as Error).message;
        }
      }
    }));

    // Parse and check membership per feed, in policy order; collect every new or edited entry.
    interface Candidate { e: RssaEntry; feed: string; order: number; card: CardState; keys: PublicJwk[]; keySet: string; selfUrl?: string }
    const candidates: Candidate[] = [];
    const served: Array<{ feed: string; present: Set<string> }> = [];
    for (const [order, feed] of feeds.entries()) {
      const st = f.members[feed];
      const body = bodies.get(feed);
      if (body === undefined) continue; // 304 (unchanged) or a fetch error already recorded on st
      let parsed;
      try { parsed = parseFeed(body); } catch (e) { st.ok = false; st.problem = (e as Error).message; continue; }

      // 2. Membership: two-way, required modules declared, cadence within the group's maxCadence.
      const pins = policy.members.find((x) => x.feed === feed)?.keys ?? [];
      const card = await this.card(feed, parsed.cardUrl, s, opts.forceCard && feed === opts.only, Array.isArray(pins) ? pins : []);
      if ("error" in card) { st.ok = false; st.problem = card.error; continue; }
      if (!card.groups.some((x) => groupRef.includes(x))) { st.ok = false; st.problem = "the member's Agent Card does not list this group (two-way membership)"; continue; }
      const missing = (policy.requiredModules ?? []).filter((x) => !card.modules.includes(x));
      if (missing.length) { st.ok = false; st.problem = `card does not declare required modules: ${missing.join(", ")}`; continue; }
      const cp = cadenceProblem(card.cadence, s);
      if (cp) { st.ok = false; st.problem = cp; continue; }
      st.ok = true;
      track(st);
      const notes: string[] = [];
      if (card.staleSince) notes.push(`identity stale since ${new Date(card.staleSince).toISOString()} (card unreachable; using last known key)`);
      if (card.forks?.length) notes.push(`key ${card.forks.join(", ")} announced two different successors; neither is trusted`);
      if (card.unannounced?.length) notes.push(`posts signed with unannounced key ${card.unannounced.join(", ")} are held (keyContinuity hold) until a rotation statement or an owner pin`);
      else if (card.keyChangedAt) notes.push(`keys changed at ${new Date(card.keyChangedAt).toISOString()} without a rotation statement`);
      st.problem = notes.length ? notes.join("; ") : undefined;
      st.held = 0;

      const keys = this.verifyKeys(card);
      const keySet = keys.map((k) => k.x).sort().join(",");
      for (const e of parsed.entries) {
        // Only entries that are new or edited since we last decided on them. Without the
        // `decided` check, every change to a member feed re-checked (and re-logged, and
        // re-tallied) everything the hub had rejected or counted before.
        const k = known.get(e.id);
        const d = decided[e.id];
        if (k && Date.parse(e.updated) <= Date.parse(k.updated)) continue;
        if (d && Date.parse(e.updated) <= Date.parse(d.updated)) continue;
        const sr = sigrej[e.id];
        if (sr && sr.keys === keySet && Date.parse(e.updated) <= Date.parse(sr.updated)) continue;
        // At capacity, anything not newer than the oldest retained entry would be evicted at once.
        if (!k && floor !== undefined && Date.parse(e.updated) <= floor && e.type !== HEARTBEAT) continue;
        candidates.push({ e, feed, order, card, keys, keySet, selfUrl: parsed.selfUrl });
      }
      served.push({ feed, present: new Set(parsed.entries.map((e) => e.id)) });
    }

    // 3. One global order (updated, then policy order, then id): the group-wide cap does not depend on fetch order.
    candidates.sort((a, b) => Date.parse(a.e.updated) - Date.parse(b.e.updated) || a.order - b.order || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
    for (const { e, feed, card, keys, keySet, selfUrl } of candidates) {
      const st = f.members[feed];
      // 3a. Cheap checks: size limits.
      if ((e.payload?.length ?? 0) > LIMITS.payload || (e.summary?.length ?? 0) > LIMITS.summary || (e.content?.length ?? 0) > LIMITS.content) {
        reject(e, feed, ["entry exceeds hub size limits"], ["size"]);
        continue;
      }
      // 3b. Group policy.
      const edit = known.has(e.id);
      const violations = checkEntry(e, feed, s, {
        depthOf: (x) => depth.get(x),
        rootOf: (x) => root.get(x),
        lastPost: (fd, r) => last.get(`${fd} ${r}`),
        postsIn: (fd, a, b) => ledger.count(fd, a, b),
        isEdit: (x) => known.has(x),
        now: () => now,
      });
      // Future-dated entries wait (not final): they become valid when their time comes.
      if (violations.some((v) => v.code === "future-dated")) { st.held = (st.held ?? 0) + 1; continue; }
      if (violations.length) { reject(e, feed, violations.map((v) => v.message), violations.map((v) => v.code)); continue; }
      // 3c. The hub's own budget, by its clock: over it, entries wait for the next hour (not final).
      const heartbeat = e.type === HEARTBEAT;
      if (heartbeat && st.lastHeartbeatAt !== undefined && now - st.lastHeartbeatAt < HEARTBEAT_MIN_MS) continue;
      if (!st.budget || now - st.budget.start >= BUDGET_WINDOW_MS) st.budget = { start: now, n: 0 };
      if (!heartbeat && st.budget.n >= MEMBER_BUDGET) { st.held = (st.held ?? 0) + 1; continue; }
      // 3d. Only then, signatures.
      if (s.signatures === "required" || e.sig) {
        const v = await verifyEntry(e, selfUrl ?? feed, keys);
        const bindFeedOk = selfUrl === undefined || selfUrl === feed;
        if (!v.ok || !bindFeedOk) {
          // Not final: the member's keys may have rotated since the hub last fetched its card.
          if (!sigrej[e.id]) count(st, ["signature"]);
          sigrej[e.id] = { updated: e.updated, keys: keySet, feed };
          const held = card.unannounced?.length ? ["held: signed with a key that has no rotation statement or owner pin (keyContinuity hold)"] : [];
          logRejection({ id: e.id, feed, at: now, reasons: [...held, ...v.checks.filter((c) => !c.ok).map((c) => c.message), ...(bindFeedOk ? [] : [`feed rel=self ${selfUrl} differs from the member URL ${feed}`])] });
          continue;
        }
      }
      delete sigrej[e.id];
      st.lastSignal = Math.max(st.lastSignal ?? 0, Math.min(Date.parse(e.updated), now));
      if (heartbeat) {
        // Absorbed, not merged: a heartbeat only proves the member is alive.
        decided[e.id] = { updated: e.updated, feed };
        st.lastHeartbeatAt = now;
        track(st).heartbeats++;
        continue;
      }
      st.budget.n++;
      if (e.type === "reaction" && e.inReplyTo) {
        // One vote per reacting entry; an edited reaction replaces its earlier value.
        react[e.id] = { target: e.inReplyTo, reaction: e.reaction! };
        decided[e.id] = { updated: e.updated, feed };
        reactionsChanged = true;
        continue;
      }
      const d = e.inReplyTo ? (depth.get(e.inReplyTo) ?? 0) + 1 : 0;
      const r = e.inReplyTo ? (root.get(e.inReplyTo) ?? e.inReplyTo) : e.id;
      depth.set(e.id, d);
      root.set(e.id, r);
      last.set(`${feed} ${r}`, Date.parse(e.updated));
      if (!edit) ledger.add(feed, Date.parse(e.updated));
      const stored: StoredEntry = { ...e, sourceFeed: feed, sourceCard: card.cardUrl, acceptedAt: now, depth: d, root: r };
      known.set(e.id, stored);
      track(st)[edit ? "edits" : "accepted"]++;
      accepted.push(e.id);
    }

    // Bookkeeping is kept only while the member still serves the entry (diff on 200). A reaction's
    // record also stays while its target is retained, because the tally is derived from it.
    for (const { feed, present } of served) {
      for (const [id, d] of Object.entries(decided)) {
        if (d.feed !== feed || present.has(id)) continue;
        if (react[id]) {
          if (known.has(react[id].target)) continue;
          delete react[id];
          reactionsChanged = true;
        }
        delete decided[id];
      }
      for (const [id, r] of Object.entries(sigrej)) if (r.feed === feed && !present.has(id)) delete sigrej[id];
    }

    if (reactionsChanged) {
      m.reactions = {};
      for (const { target, reaction } of Object.values(react)) {
        const t = (m.reactions[target] ??= {});
        t[reaction] = (t[reaction] ?? 0) + 1;
      }
    }

    // Retention: the newest maxEntries within the byte budget.
    const all = [...known.values()].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    let bytes = 0, keep = 0;
    while (keep < Math.min(all.length, this.c.maxEntries)) {
      bytes += JSON.stringify(all[keep]).length;
      if (bytes > ENTRY_BYTES && keep > 0) break;
      keep++;
    }
    const before = f.entries;
    f.entries = all.slice(0, keep);
    // The floor only moves forward: once entries are evicted they stay evicted, even on refreshes that trim nothing.
    if (keep < all.length) {
      const oldest = f.entries[keep - 1].updated;
      if (!m.floor || Date.parse(oldest) > Date.parse(m.floor)) m.floor = oldest;
    }
    const retained = new Set(f.entries.map((e) => e.id));
    accepted.splice(0, accepted.length, ...accepted.filter((x) => retained.has(x)));
    m.refreshedAt = now;

    // Re-render the merged feed only when what it holds changed.
    const changed = before.length !== f.entries.length || f.entries.some((e, i) => before[i] !== e) || !m.feedEtag;
    const xmlPuts: Array<[string, string, string]> = [];
    const xmlDels: Array<[string, string]> = [];
    if (changed) {
      const xml = this.render(m, f.entries);
      m.feedEtag = `"${(await hmacHex("etag", xml)).slice(0, 16)}"`;
      const n = Math.max(1, Math.ceil(xml.length / XML_CHUNK));
      for (let i = 0; i < n; i++) xmlPuts.push(["xml", String(i), xml.slice(i * XML_CHUNK, (i + 1) * XML_CHUNK)]);
      for (let i = n; i < (m.xmlChunks ?? 0); i++) xmlDels.push(["xml", String(i)]);
      m.xmlChunks = n;
      this.xml = { etag: m.feedEtag, body: xml };
    }

    // Member index: the policy, every member feed and every member card (#13).
    if (this.c.reindex) {
      const want = [...new Set([m.policyUrl, ...allFeeds, ...allFeeds.map((x) => f.cards[x]?.cardUrl).filter((x): x is string => !!x)])].sort();
      if (want.join("\n") !== m.indexed.join("\n")) {
        try { await this.c.reindex(this.c.id, m.indexed, want); m.indexed = want; } catch { /* retried on the next refresh */ }
      }
    }

    await this.commit(xmlPuts, xmlDels);
    if (accepted.length) await this.notifySubscribers(m);
    return accepted;
  }

  private render(m: Meta, entries: StoredEntry[]): string {
    const p = m.policy;
    return atomXml(
      { feedUrl: this.feedUrl(), id: p?.group ?? m.policyUrl, title: p?.name ?? `RSSA group ${m.id}`, hubUrl: `${this.c.base()}/` },
      entries.map(strip),
    );
  }

  private async notifySubscribers(m: Meta) {
    const subs = await this.loadSubs();
    const now = this.c.now();
    for (const [k, s] of Object.entries(subs)) if (s.expires <= now) delete subs[k];
    await this.commit();
    const live = Object.values(subs);
    if (!live.length || !this.c.notify) return;
    try {
      await this.c.notify({ group: m.id, topic: this.feedUrl(), etag: m.feedEtag ?? "", subs: live.map((s) => ({ callback: s.callback, secret: s.secret })) });
    } catch { /* delivery is best-effort; WebSub has no retry obligation */ }
  }

  // ---------------- WebSub subscriptions ----------------

  private async subscribe(form: URLSearchParams): Promise<Response> {
    const mode = form.get("hub.mode")!;
    const callback = form.get("hub.callback");
    const topic = form.get("hub.topic");
    if (!callback || !topic || !/^https?:\/\//.test(callback)) return new Response("hub.callback and hub.topic required", { status: 400 });
    const lease = Math.min(Number(form.get("hub.lease_seconds") ?? 864000) || 864000, 864000);
    if (mode === "subscribe") {
      const subs = await this.loadSubs();
      if (!subs[callback] && Object.keys(subs).length >= MAX_SUBSCRIBERS) return new Response(`this group has ${MAX_SUBSCRIBERS} subscribers, the hub's limit`, { status: 429 });
    }
    // Verification of intent, outside the group lock (a slow callback must not hold up refreshes).
    const challenge = crypto.randomUUID();
    const u = new URL(callback);
    u.searchParams.set("hub.mode", mode);
    u.searchParams.set("hub.topic", topic);
    u.searchParams.set("hub.challenge", challenge);
    u.searchParams.set("hub.lease_seconds", String(lease));
    let ok = false;
    try {
      const r = await this.c.fetch(u.toString(), { headers: { "user-agent": USER_AGENT } });
      ok = r.ok && (await r.text()).trim() === challenge;
    } catch { ok = false; }
    if (!ok) return new Response("verification of intent failed: callback did not echo hub.challenge", { status: 409 });
    return this.serial(async () => {
      const subs = await this.loadSubs();
      delete subs[callback];
      if (mode === "subscribe") subs[callback] = { callback, topic, secret: form.get("hub.secret") ?? undefined, expires: this.c.now() + lease * 1000, createdAt: this.c.now() };
      await this.commit();
      return new Response(null, { status: 202 });
    });
  }

  // ---------------- reads ----------------

  private async noteReader(req: Request) {
    // Day-60 gate metric: distinct readers that identify their Agent Card in User-Agent ("reader=<card URL>").
    const mt = /reader=(\S+)/.exec(req.headers.get("user-agent") ?? "");
    if (!mt) return;
    const seen = await this.c.rows.get("reader", mt[1]);
    if (seen && this.c.now() - Number(seen) < 86_400_000) return;
    await this.c.rows.write([["reader", mt[1], String(this.c.now())]], []);
  }

  /** A member's declared cadence, last signal and liveness state. */
  private live(f: Full, feed: string) {
    const st = f.members[feed];
    const card = f.cards[feed];
    // Before heartbeats existed the hub kept no lastSignal: fall back to the member's newest retained entry.
    let lastSignal = st?.lastSignal;
    if (lastSignal === undefined) for (const e of f.entries) if (e.sourceFeed === feed) lastSignal = Math.max(lastSignal ?? 0, Date.parse(e.updated));
    return {
      cadence: card?.cadence, lastSignal: lastSignal !== undefined ? new Date(lastSignal).toISOString() : undefined, held: st?.held || undefined,
      liveness: liveness({ cadence: card?.cadence, lastSignal, now: this.c.now(), ok: !!st?.ok, slackMs: LIVENESS_SLACK_MS }),
    };
  }

  private async mergedXml(m: Meta): Promise<string> {
    if (this.xml && this.xml.etag === m.feedEtag) return this.xml.body;
    const chunks = await this.c.rows.list("xml");
    let body: string;
    if (chunks.length && m.xmlChunks) {
      body = chunks.filter(([k]) => Number(k) < m.xmlChunks!).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => v).join("");
    } else {
      body = this.render(m, (await this.loadFull()).entries);
    }
    this.xml = { etag: m.feedEtag ?? "", body };
    return body;
  }

  /** Answers /g/<id>/… routes. The hub checks admin auth before forwarding `refresh` and `import`. */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const leaf = /^\/g\/[0-9a-f]{12}\/?(.*)$/.exec(url.pathname)?.[1] ?? "";
    try {
      if (req.method === "POST" && leaf === "import") return j(await this.importLegacy(await req.json()));
      const m = await this.loadMeta();
      if (!m) return j({ error: "unknown group" }, 404);
      if (req.method === "POST" && leaf === "websub") return this.subscribe(new URLSearchParams(await req.text()));
      if (req.method === "GET" && (leaf === "feed.atom" || leaf === "")) {
        await this.noteReader(req);
        if (m.feedEtag && req.headers.get("if-none-match") === m.feedEtag) return new Response(null, { status: 304 });
        const to = url.searchParams.get("to"), type = url.searchParams.get("type"), thread = url.searchParams.get("thread");
        let xml: string;
        if (to || type || thread) {
          // Exact-match filtering only (addressee, type prefix, thread); anything semantic is the consumer's job.
          const fe = (await this.loadFull()).entries.filter((e) => (!to || (e.to ?? "group") === to) && (!type || (e.type ?? "").startsWith(type)) && (!thread || e.root === thread || e.id === thread));
          xml = atomXml({ feedUrl: `${this.feedUrl()}${url.search}`, id: m.policy?.group ?? m.policyUrl, title: m.policy?.name ?? m.id, hubUrl: `${this.c.base()}/` }, fe.map(strip));
        } else xml = await this.mergedXml(m);
        return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8", etag: m.feedEtag ?? "", "cache-control": "public, no-cache", link: `<${this.c.base()}/>; rel="hub"` } });
      }
      if (req.method === "GET" && leaf === "roster.opml") {
        if (!m.policy) return j({ error: "policy not loaded yet", problem: m.policyProblem }, 503);
        return new Response(rosterOpml(m.policy), { headers: { "content-type": "text/x-opml; charset=utf-8" } });
      }
      if (req.method === "GET" && leaf === "reactions.json") return j(m.reactions);
      if (req.method === "GET" && leaf === "status.json") {
        const f = await this.loadFull();
        const readers = (await this.c.rows.list("reader")).map(([k]) => k);
        const subs = Object.values(await this.loadSubs()).filter((s) => s.expires > this.c.now());
        const memberCards = new Set(Object.values(f.cards).map((c) => c.cardUrl));
        return j({
          group: m.policy?.group ?? m.policyUrl, name: m.policy?.name, version: m.policy?.version, preset: m.policy?.preset ?? "standard",
          policyProblem: m.policyProblem, refreshedAt: m.refreshedAt && new Date(m.refreshedAt).toISOString(),
          members: Object.values(f.members).map(({ track: _t, budget: _b, lastSignal: _l, lastHeartbeatAt: _h, ...x }) => ({
            ...x, lastFetch: this.lastFetch.get(x.feed), ...this.live(f, x.feed),
          })),
          entries: f.entries.length, rejected: m.rejected.slice(0, 20),
          gate: { readers: readers.length, outsideReaders: readers.filter((r) => !memberCards.has(r)).length, websubSubscribers: subs.length },
        });
      }
      if (req.method === "GET" && leaf === "identity.json") {
        // The identity log (non-normative): each member's trusted keys and every change to its key set.
        const f = await this.loadFull();
        const keyContinuity = m.policy ? effectiveSettings(m.policy).keyContinuity : undefined;
        return j({
          group: m.policy?.group ?? m.policyUrl, keyContinuity,
          members: Object.values(f.cards).map((c) => ({
            feed: c.feed, card: c.cardUrl, keys: c.thumbs ?? [], unannounced: c.unannounced ?? [], forks: c.forks ?? [],
            held: !!c.unannounced?.length, history: (c.history ?? []).map((h) => ({ ...h, at: new Date(h.at).toISOString() })),
          })),
        });
      }
      if (req.method === "GET" && leaf === "members.json") {
        // Each member's track record (non-normative): facts the hub saw, never a score.
        const f = await this.loadFull();
        const received: Record<string, Record<string, number>> = {};
        for (const e of f.entries) {
          const t = m.reactions[e.id];
          if (!t || !e.sourceFeed) continue;
          const r = (received[e.sourceFeed] ??= {});
          for (const [k, n] of Object.entries(t)) r[k] = (r[k] ?? 0) + n;
        }
        return j({
          group: m.policy?.group ?? m.policyUrl,
          note: "Facts this hub observed for each member. Not a score: what they mean is the reader's call.",
          members: Object.values(f.members).map((st) => {
            const t = st.track;
            const h = f.cards[st.feed]?.history ?? [];
            return {
              feed: st.feed, firstSeen: t && new Date(t.firstSeen).toISOString(),
              accepted: t?.accepted ?? 0, edits: t?.edits ?? 0, heartbeats: t?.heartbeats ?? 0, rejected: t?.rejected ?? {},
              reactionsReceived: received[st.feed] ?? {},
              keyChanges: { announced: h.filter((x) => x.change === "rotated" || x.change === "pinned").length, unannounced: h.filter((x) => x.change === "unannounced" || x.change === "held").length, forks: h.filter((x) => x.change === "fork").length },
              ...this.live(f, st.feed),
            };
          }),
        });
      }
      if (req.method === "POST" && leaf === "refresh") return j({ accepted: await this.refresh() });
      if (req.method === "POST" && leaf === "join") {
        // Open groups only: an agent joins by naming its feed; its card must list this group.
        if (!m.policy || effectiveSettings(m.policy).membership !== "open") return j({ error: "this group is not open; ask the owner to add your feed to policy.json" }, 403);
        const { feed } = (await req.json()) as { feed: string };
        if (!/^https:\/\/\S+$/.test(feed ?? "")) return j({ error: "feed must be an https URL" }, 400);
        const accepted = await this.serial(async () => {
          if (!m.joined.includes(feed)) { m.joined.push(feed); await this.commit(); }
          return this.doRefresh({});
        });
        const st = this.full!.members[feed];
        return j({ member: st?.ok ?? false, problem: st?.problem, accepted: accepted.length }, st?.ok ? 200 : 422);
      }
      return j({ error: "not found" }, 404);
    } catch (e) {
      return j({ error: (e as Error).message }, 500);
    }
  }

  // ---------------- migration from the v0.1 KV layout ----------------

  /** Imports a group from the v0.1 KV layout (`group:<id>`, `card:<feed>`, `subs:<topic>`, `readers:<id>`). Refuses if the group exists. */
  importLegacy(legacy: LegacyGroup): Promise<Record<string, number>> {
    return this.serial(async () => {
      if (await this.loadMeta()) throw new Error("group already exists here; import refused");
      const g = legacy.state;
      if (g.id !== this.c.id) throw new Error(`legacy state is for group ${g.id}, not ${this.c.id}`);
      this.meta = {
        id: g.id, policyUrl: g.policyUrl, policy: g.policy, policyProblem: g.policyProblem, joined: g.joined ?? [],
        rejected: g.rejected ?? [], reactions: g.reactions ?? {}, floor: g.floor, refreshedAt: g.refreshedAt, indexed: [],
      };
      const f: Full = { members: {}, cards: {}, entries: [...(g.entries ?? [])], decided: {}, sigrej: {}, react: {} };
      for (const [k, st] of Object.entries(g.members ?? {})) { const { lastFetch: _l, ...rest } = st as MemberStatus & { lastFetch?: number }; f.members[k] = rest; }
      for (const [k, c] of Object.entries(legacy.cards ?? {})) if (c) f.cards[k] = c;
      for (const [k, v] of Object.entries((g.decided ?? {}) as Record<string, string | Full["decided"][string]>)) f.decided[k] = typeof v === "string" ? { updated: v } : v;
      for (const [k, v] of Object.entries((g.sigRejected ?? {}) as Full["sigrej"])) f.sigrej[k] = v;
      for (const [k, v] of Object.entries((g.reactionsBy ?? {}) as Full["react"])) f.react[k] = v;
      f.entries.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
      this.full = f;
      this.subs = {};
      for (const s of legacy.subs ?? []) this.subs[s.callback] = s;
      const xml = this.render(this.meta, f.entries);
      this.meta.feedEtag = `"${(await hmacHex("etag", xml)).slice(0, 16)}"`;
      const n = Math.max(1, Math.ceil(xml.length / XML_CHUNK));
      this.meta.xmlChunks = n;
      const extra: Array<[string, string, string]> = [];
      for (let i = 0; i < n; i++) extra.push(["xml", String(i), xml.slice(i * XML_CHUNK, (i + 1) * XML_CHUNK)]);
      for (const [card, at] of Object.entries(legacy.readers ?? {})) extra.push(["reader", card, String(at)]);
      await this.commit(extra);
      this.xml = { etag: this.meta.feedEtag, body: xml };
      return {
        entries: f.entries.length, rejected: this.meta.rejected.length, members: Object.keys(f.members).length, cards: Object.keys(f.cards).length,
        decided: Object.keys(f.decided).length, sigRejected: Object.keys(f.sigrej).length, reactions: Object.keys(f.react).length,
        subscribers: Object.keys(this.subs).length, readers: Object.keys(legacy.readers ?? {}).length,
      };
    });
  }
}

export interface LegacyGroup {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  cards: Record<string, CardState | undefined>;
  subs: Subscription[];
  readers: Record<string, number>;
}

/** WebSub content distribution: POSTs the group feed to each subscriber. Shared by the Queue consumer and Node. */
export async function deliver(
  msgs: DeliveryMessage[],
  feedOf: (group: string) => Promise<string>,
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  base: string,
  timeoutMs = 5000,
): Promise<number> {
  // Several messages for one group in a batch: the latest feed covers them all.
  const latest = new Map<string, DeliveryMessage>();
  for (const m of msgs) latest.set(m.group, m);
  let sent = 0;
  for (const m of latest.values()) {
    const body = await feedOf(m.group);
    await Promise.all(m.subs.map(async (s) => {
      const headers: Record<string, string> = { "content-type": "application/atom+xml", link: `<${m.topic}>; rel="self", <${base}/>; rel="hub"` };
      if (s.secret) headers["x-hub-signature"] = `sha256=${await hmacHex(s.secret, body)}`;
      try {
        await fetch(s.callback, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
        sent++;
      } catch { /* subscriber down; WebSub has no retry obligation */ }
    }));
  }
  return sent;
}
