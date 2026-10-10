// High-level helpers: publish a feed, read a feed, read a group, filter locally.

import { cardModules, findRssa } from "./card.ts";
import { atomXml, jsonFeed, parseFeed, rssXml, type FeedMeta, type ParsedFeed, type RssaEntry } from "./feed.ts";
import { getJson, resolveKeys, type Fetcher, type PublicJwk, type RssaKey } from "./keys.ts";
import {
  HEARTBEAT, PostLedger, cadenceProblem, checkEntry, effectiveSettings, liveness, verifyPolicy,
  type GroupPolicy, type Liveness, type Violation,
} from "./policy.ts";
import { signEntry, verifyEntry, type Check } from "./sign.ts";

export const USER_AGENT = "rssa-sdk/0.2 (+https://rssa.getvda.ai)";

/** Current time as an RFC 3339 instant at whole seconds (RSS 2.0 dates carry seconds only). */
export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export type NewEntry = Omit<RssaEntry, "id" | "updated" | "payload" | "sig"> & { id?: string; updated?: string };

/** Fills id (urn:uuid) and updated (now, whole seconds) if missing. */
export function entry(e: NewEntry): RssaEntry {
  const updated = e.updated ? new Date(Date.parse(e.updated)).toISOString().replace(/\.\d{3}Z$/, "Z") : now();
  return { ...e, id: e.id ?? `urn:uuid:${crypto.randomUUID()}`, updated } as RssaEntry;
}

/**
 * The heartbeat entry: proof of life between posts. Keep ONE per feed with a fixed `id` and republish
 * it with a fresh `updated` (an edit), so the feed never grows. Declare the promise as params.cadence.
 */
export function heartbeat(id: string, updated?: string): RssaEntry {
  return entry({ id, updated, type: "agent.heartbeat", title: "heartbeat" });
}

/**
 * Builds a complete feed (format: "atom" default, "rss" or "json"). With `key`, every entry is signed.
 * Returns a string: store it however your platform stores files (disk, GCS, R2, S3, a route handler).
 */
/** Content-Type to serve each format with. */
export const MEDIA_TYPES = { atom: "application/atom+xml", rss: "application/rss+xml", json: "application/feed+json" } as const;

export async function buildFeed(meta: FeedMeta & { key?: RssaKey; format?: keyof typeof MEDIA_TYPES }, entries: (RssaEntry | NewEntry)[]): Promise<string> {
  const full = entries.map((e) => entry(e as NewEntry));
  const ids = new Set<string>();
  for (const e of full) {
    if (ids.has(e.id)) throw new Error(`duplicate entry id ${e.id}`);
    ids.add(e.id);
  }
  full.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  const out = meta.key ? await Promise.all(full.map((e) => signEntry(e, meta.feedUrl, meta.key!))) : full;
  if (meta.format === "rss") return rssXml(meta, out);
  if (meta.format === "json") return jsonFeed(meta, out);
  return atomXml(meta, out);
}

/** Tells a WebSub hub that a feed changed. Never throws; returns the HTTP status (0 on network error). */
export async function pingHub(hubUrl: string, feedUrl: string, fetcher: Fetcher = fetch): Promise<number> {
  try {
    const r = await fetcher(hubUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body: `hub.mode=publish&hub.url=${encodeURIComponent(feedUrl)}`,
    });
    return r.status;
  } catch {
    return 0;
  }
}

export interface ReadOptions {
  fetcher?: Fetcher;
  /** Your own Agent Card URL. Sent in User-Agent so publishers and hubs can count real subscribers. */
  readerCard?: string;
  /** Require valid signatures (default: required if the publisher's card lists the sign module). */
  requireSignatures?: boolean;
  /** The reader's clock in ms (default Date.now): for the future-dated check and liveness. */
  now?: () => number;
}

export interface ReadEntry extends RssaEntry {
  /** True when the signature, bindings and content hash all verified. */
  verified: boolean;
  /** The feed this entry is attributed to. */
  from: string;
  checks: Check[];
  violations?: Violation[];
}

export interface FeedRead {
  feed: ParsedFeed;
  card?: any;
  keys: PublicJwk[];
  entries: ReadEntry[];
  problems: string[];
}

export function readerHeaders(o: ReadOptions = {}) {
  return { "user-agent": o.readerCard ? `${USER_AGENT} reader=${o.readerCard}` : USER_AGENT, accept: "application/atom+xml, application/rss+xml, application/feed+json, application/json;q=0.9, */*;q=0.5" };
}

/**
 * Fetches a feed, follows rel=describedby to the Agent Card, checks the card points back at
 * the feed, resolves keys and verifies every signed entry. Unsigned entries are returned
 * with verified=false unless signatures are required, in which case they are dropped.
 */
export async function readFeed(url: string, o: ReadOptions = {}): Promise<FeedRead> {
  const fetcher = o.fetcher ?? fetch;
  const r = await fetcher(url, { headers: readerHeaders(o) });
  if (!r.ok) throw new Error(`GET ${url} returned ${r.status}`);
  const feed = parseFeed(await r.text());
  const problems = [...feed.problems];
  const feedUrl = feed.selfUrl ?? url;
  let card: any;
  let keys: PublicJwk[] = [];
  if (feed.cardUrl) {
    try {
      card = await getJson(feed.cardUrl, fetcher);
      const ext = findRssa(card);
      if (!ext) problems.push(`card ${feed.cardUrl} has no RSSA extension`);
      else if (ext.params.feed !== feedUrl) problems.push(`card ${feed.cardUrl} names feed ${ext.params.feed}, not ${feedUrl} — the card does not vouch for this feed`);
      else if (ext.params.keys) keys = await resolveKeys(ext.params.keys, fetcher);
    } catch (e) {
      problems.push(`card: ${(e as Error).message}`);
    }
  }
  const requireSigs = o.requireSignatures ?? cardModules(card).includes("sign");
  const entries: ReadEntry[] = [];
  for (const e of feed.entries) {
    const attributed = e.sourceFeed ?? feedUrl;
    if (!e.sig) {
      if (!requireSigs) entries.push({ ...e, verified: false, from: attributed, checks: [] });
      else problems.push(`dropped unsigned entry ${e.id}`);
      continue;
    }
    // Entries merged by a hub carry their own feed in atom:source; their keys come from that feed's card.
    const k = e.sourceFeed && e.sourceFeed !== feedUrl ? await keysForFeed(e.sourceFeed, e.sourceCard, fetcher) : keys;
    const v = await verifyEntry(e, attributed, k);
    if (v.ok || !requireSigs) entries.push({ ...e, verified: v.ok, from: attributed, checks: v.checks });
    else problems.push(`dropped entry ${e.id}: ${v.checks.filter((c) => !c.ok).map((c) => c.message).join("; ")}`);
  }
  return { feed, card, keys, entries, problems };
}

const keyCache = new Map<string, Promise<PublicJwk[]>>();
/** Keys for an entry a hub merged from another feed: from that feed's card (atom:source), only if the card names the feed. */
export async function keysForFeed(feedUrl: string, cardUrl: string | undefined, fetcher: Fetcher): Promise<PublicJwk[]> {
  if (!cardUrl) return [];
  const k = `${feedUrl} ${cardUrl}`;
  if (!keyCache.has(k)) {
    keyCache.set(k, (async () => {
      const card = await getJson(cardUrl, fetcher);
      const ext = findRssa(card);
      if (!ext || ext.params.feed !== feedUrl || !ext.params.keys) return [];
      return resolveKeys(ext.params.keys, fetcher);
    })().catch(() => []));
  }
  return keyCache.get(k)!;
}

export interface MemberLiveness { cadence?: string; lastSignal?: string; state: Liveness }

export interface GroupRead {
  policy: GroupPolicy;
  policyVerified: boolean;
  /** Group entries, newest first. Heartbeats are not entries: they feed `liveness`. */
  entries: ReadEntry[];
  /** Per member feed: its declared cadence, its last signal, and live / late / silent / undeclared / failing. */
  liveness: Record<string, MemberLiveness>;
  /** Member feeds that failed two-way membership or could not be read. */
  problems: string[];
}

/**
 * Hubless group reading (fine for open groups and two-party links): fetches the policy,
 * verifies it, reads every member feed, checks two-way membership and the group's policy.
 */
export async function readGroup(policyUrl: string, o: ReadOptions = {}): Promise<GroupRead> {
  const fetcher = o.fetcher ?? fetch;
  const policy = (await getJson(policyUrl, fetcher)) as GroupPolicy;
  const problems: string[] = [];
  const pv = await verifyPolicy(policy, fetcher);
  if (!pv.ok) problems.push(`policy signature: ${pv.error}`);
  const s = effectiveSettings(policy);
  const all: ReadEntry[] = [];
  const clock = o.now ?? Date.now;
  const members: Record<string, { cadence?: string; ok: boolean; lastSignal?: number }> = {};
  await Promise.all(policy.members.map(async (m) => {
    members[m.feed] = { ok: false };
    try {
      const fr = await readFeed(m.feed, { ...o, requireSignatures: s.signatures === "required" || o.requireSignatures });
      const params = findRssa(fr.card)?.params;
      const groups: string[] = params?.groups ?? [];
      if (!groups.includes(policy.group) && !groups.includes(policyUrl)) {
        problems.push(`${m.feed}: its Agent Card does not list this group — not a member (two-way membership)`);
        return;
      }
      const cp = cadenceProblem(params?.cadence, s);
      if (cp) { problems.push(`${m.feed}: ${cp}`); return; }
      members[m.feed] = { ok: true, cadence: params?.cadence };
      problems.push(...fr.problems.map((p) => `${m.feed}: ${p}`));
      all.push(...fr.entries);
    } catch (e) {
      problems.push(`${m.feed}: ${(e as Error).message}`);
    }
  }));
  // One global order (by updated, then feed, then id), so the group-wide cap gives every reader the same answer.
  all.sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated) || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const depth = new Map<string, number>(), root = new Map<string, string>(), last = new Map<string, number>();
  const ledger = new PostLedger();
  const kept: ReadEntry[] = [];
  const signal = (feed: string, t: number) => { const mm = members[feed]; if (mm) mm.lastSignal = Math.max(mm.lastSignal ?? 0, t); };
  for (const e of all) {
    const violations = checkEntry(e, e.from, s, {
      depthOf: (id) => depth.get(id),
      rootOf: (id) => root.get(id),
      lastPost: (f, r) => last.get(`${f} ${r}`),
      postsIn: (f, a, b) => ledger.count(f, a, b),
      now: clock,
    });
    if (violations.length) { problems.push(`dropped ${e.id}: ${violations.map((v) => v.message).join("; ")}`); continue; }
    signal(e.from, Date.parse(e.updated));
    if (e.type === HEARTBEAT) continue;
    if (e.type !== "reaction") ledger.add(e.from, Date.parse(e.updated));
    const d = e.inReplyTo ? (depth.get(e.inReplyTo) ?? 0) + 1 : 0;
    const r = e.inReplyTo ? (root.get(e.inReplyTo) ?? e.inReplyTo) : e.id;
    depth.set(e.id, d);
    root.set(e.id, r);
    last.set(`${e.from} ${r}`, Date.parse(e.updated));
    kept.push(e);
  }
  const t = clock();
  const live: Record<string, MemberLiveness> = {};
  for (const [feed, mm] of Object.entries(members)) {
    live[feed] = { cadence: mm.cadence, lastSignal: mm.lastSignal ? new Date(mm.lastSignal).toISOString() : undefined, state: liveness({ cadence: mm.cadence, lastSignal: mm.lastSignal, now: t, ok: mm.ok }) };
  }
  return { policy, policyVerified: pv.ok, entries: kept.reverse(), liveness: live, problems };
}

export interface LocalPolicy {
  /** Only entries with a verified signature. */
  signedOnly?: boolean;
  /** Type prefixes to accept, e.g. ["exception.", "question.asked"]. */
  types?: string[];
  /** Addresses to accept, e.g. ["group", "role:logistics", "https://me.example/card.json"]. */
  to?: string[];
  /** Feeds to accept entries from. */
  from?: string[];
}

/**
 * Consumer-side guardrail, applied with plain code before any model reads an entry.
 * Always allowed to be stricter than the group.
 */
export function localFilter<T extends ReadEntry>(entries: T[], p: LocalPolicy): T[] {
  return entries.filter((e) =>
    (!p.signedOnly || e.verified) &&
    (!p.types || (e.type !== undefined && p.types.some((t) => e.type === t || (t.endsWith(".") && e.type!.startsWith(t))))) &&
    (!p.to || p.to.includes(e.to ?? "group")) &&
    (!p.from || p.from.includes(e.from)));
}
