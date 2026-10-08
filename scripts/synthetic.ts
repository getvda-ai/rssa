// A synthetic RSS-A group for performance tests and scale regression tests: N members with
// seeded keys, signed Atom feeds, cards and a signed standard-preset policy, served by an
// in-memory "web" that counts requests and can add latency and ETags.

import {
  atomXml, keyFromSeed, signEntry, signPolicy, withRssa, type GroupPolicy, type RssaEntry, type RssaKey,
} from "../packages/sdk-js/src/index.ts";

/** A fake web: url → body, optional per-request latency, ETag/304 support, counted subrequests. */
export function fakeWeb(o: { latencyMs?: number; etags?: boolean } = {}) {
  const docs = new Map<string, string>();
  const posted: string[] = [];
  let subrequests = 0;
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    subrequests++;
    if (o.latencyMs) await new Promise((r) => setTimeout(r, o.latencyMs));
    if (init?.method === "POST") { posted.push(url); return new Response(null, { status: 202 }); }
    const u = new URL(url);
    if (u.searchParams.has("hub.challenge")) return new Response(u.searchParams.get("hub.challenge"));
    const body = docs.get(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    const etag = `"${body.length}-${hash32(body)}"`;
    const h = new Headers(init?.headers);
    if (o.etags && h.get("if-none-match") === etag) return new Response(null, { status: 304 });
    return new Response(body, { headers: o.etags ? { etag } : {} });
  };
  return { docs, fetcher, posted, get subrequests() { return subrequests; }, resetCount() { subrequests = 0; posted.length = 0; } };
}
function hash32(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(16); }

// ---------- synthetic groups ----------

export const BASE = "https://perf.test";
export const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n * 131 + (n >> 8)) & 0xff);
export const T0 = Date.parse("2026-10-07T00:00:00Z");
export const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
export const feedUrl = (i: number) => `${BASE}/a${i}/rssa/feed.atom`;
export const cardUrl = (i: number) => `${BASE}/a${i}/.well-known/agent-card.json`;
export const POLICY = `${BASE}/groups/g/policy.json`;
const OWNER_JWKS = `${BASE}/groups/g/owner-jwks.json`;

export interface Group { web: ReturnType<typeof fakeWeb>; keys: RssaKey[]; entries: RssaEntry[][]; members: number }

export async function entryFor(i: number, n: number, contentBytes: number, key: RssaKey): Promise<RssaEntry> {
  // Root posts spaced 2 minutes apart per agent; every 4th is a reply to the previous agent's post
  // of the same index, posted later, so minInterval and maxDepth are respected.
  const reply = n % 4 === 3 && i > 0;
  const e: RssaEntry = {
    id: `tag:perf.test,2026:a${i}-${n}`,
    updated: iso(T0 + n * 120_000 + i * 1000 + (reply ? 60_000 : 0)),
    type: reply ? "answer.posted" : "brief.published",
    to: n % 3 === 0 ? "role:ops" : "group",
    title: `Agent ${i} item ${n}`,
    summary: `Agent ${i} item ${n}: a short summary well under the 280-character limit of the standard preset.`,
    content: contentBytes ? "x".repeat(contentBytes) : `Body of item ${n} from agent ${i}.`,
    ...(reply ? { inReplyTo: `tag:perf.test,2026:a${i - 1}-${n}` } : {}),
  };
  return signEntry(e, feedUrl(i), key);
}

export async function buildGroup(members: number, perFeed: number, o: { contentBytes?: number; latencyMs?: number; etags?: boolean } = {}): Promise<Group> {
  const web = fakeWeb(o);
  const owner = await keyFromSeed(seed(99_999));
  web.docs.set(OWNER_JWKS, JSON.stringify({ keys: [owner.publicJwk] }));
  const keys: RssaKey[] = [];
  const entries: RssaEntry[][] = [];
  for (let i = 0; i < members; i++) {
    const key = await keyFromSeed(seed(i + 1));
    keys.push(key);
    const es: RssaEntry[] = [];
    for (let n = 0; n < perFeed; n++) es.push(await entryFor(i, n, o.contentBytes ?? 0, key));
    entries.push(es);
    publish(web, i, es);
    web.docs.set(cardUrl(i), JSON.stringify(withRssa({ name: `Agent ${i}`, url: `${BASE}/a${i}/a2a`, version: "1", capabilities: {}, skills: [] },
      { feed: feedUrl(i), modules: ["sign", "groups", "thread", "controls"], groups: [POLICY], keys: { keys: [key.publicJwk] } })));
  }
  const policy: GroupPolicy = {
    version: 1, group: POLICY, name: `perf group (${members})`, owner: OWNER_JWKS, preset: "standard",
    members: Array.from({ length: members }, (_, i) => ({ feed: feedUrl(i), role: i % 5 === 0 ? "ops" : "member" })),
    requiredModules: ["sign", "groups", "thread", "controls"],
  };
  web.docs.set(POLICY, JSON.stringify(await signPolicy(policy, owner)));
  return { web, keys, entries, members };
}

export function publish(web: ReturnType<typeof fakeWeb>, i: number, es: RssaEntry[]) {
  const sorted = [...es].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  web.docs.set(feedUrl(i), atomXml({ feedUrl: feedUrl(i), cardUrl: cardUrl(i), title: `Agent ${i}`, hubUrl: "https://hub.perf.test/" }, sorted));
}

