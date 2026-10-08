// Tests for the v0.2 hub layout (docs/HUB-ARCHITECTURE.md): one Group per group, rows written as
// diffs, a member index for pings, targeted refresh, per-group serialization, bookkeeping pruned by
// presence, migration from the v0.1 KV layout, and the budget guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, groupId, memoryStore } from "../src/hub.ts";
import { MAX_SUBSCRIBERS } from "../src/group.ts";
import { keyFromSeed, signEntry, type RssaEntry } from "../../packages/sdk-js/src/index.ts";
import { POLICY, T0, buildGroup, cardUrl, entryFor, feedUrl, iso, publish, seed, type Group as G } from "../../scripts/synthetic.ts";

/** A memoryStore that counts row reads and writes (keys under r:), i.e. SQLite rows in production. */
function countingStore() {
  const s = memoryStore();
  const n = { reads: 0, writes: 0, kvReads: 0, kvWrites: 0 };
  return {
    m: s.m, n,
    reset() { n.reads = n.writes = n.kvReads = n.kvWrites = 0; },
    get: async (k: string) => { if (k.startsWith("r:")) n.reads++; else n.kvReads++; return s.get(k); },
    put: async (k: string, v: string) => { if (k.startsWith("r:")) n.writes++; else n.kvWrites++; return s.put(k, v); },
    delete: async (k: string) => { if (k.startsWith("r:")) n.writes++; else n.kvWrites++; return s.delete(k); },
    list: s.list,
  };
}

function setup(g: G, store = countingStore()) {
  let t = T0 + 86_400_000;
  const mk = () => new Hub({ store, fetch: g.web.fetcher, now: () => t, adminToken: "x", baseUrl: "https://hub.test" });
  return { hub: mk(), mk, store, tick: (ms: number) => { t += ms; } };
}
const ping = (hub: Hub, url: string) => hub.websub(new URLSearchParams({ "hub.mode": "publish", "hub.url": url }));
const status = async (hub: Hub, id: string) => (await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json()) as any;
const later = (n: number) => iso(T0 + 3_600_000 + n * 600_000);

test("steady state writes almost nothing: idle refreshes write one row (refreshedAt), and no index writes", async () => {
  const g = await buildGroup(5, 4, { etags: true });
  const { hub, store, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  for (let k = 0; k < 3; k++) {
    tick(300_000);
    store.reset();
    assert.deepEqual(await hub.refresh(id), []);
    assert.ok(store.n.writes <= 1, `idle refresh ${k + 1} wrote ${store.n.writes} rows`);
    assert.equal(store.n.kvWrites, 0, "member index untouched");
  }
});

test("a 304 read from a cold group (after hibernation) reads one row, not the whole group", async () => {
  const g = await buildGroup(10, 10, { etags: true });
  const { hub, mk, store } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const etag = (await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`))).headers.get("etag")!;
  const cold = mk();
  store.reset();
  const r = await cold.handle(new Request(`https://hub.test/g/${id}/feed.atom`, { headers: { "if-none-match": etag } }));
  assert.equal(r.status, 304);
  assert.ok(store.n.reads <= 1, `${store.n.reads} rows read`);
  // A full read of a cold group reads the meta row and the feed chunks, not the entries.
  store.reset();
  assert.equal((await cold.handle(new Request(`https://hub.test/g/${id}/feed.atom`))).status, 200);
  assert.ok(store.n.reads <= 1 + 2, `${store.n.reads} rows read for a 200`);
});

test("a ping costs one index read and refetches only the pinged feed", async () => {
  const g = await buildGroup(10, 2, { etags: true });
  const { hub, store } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const e = await entryFor(3, 50, 0, g.keys[3]);
  g.entries[3].push(e);
  publish(g.web, 3, g.entries[3]);
  g.web.resetCount();
  store.reset();
  assert.equal((await ping(hub, feedUrl(3))).status, 204);
  assert.equal(store.n.kvReads, 1, "one member-index read");
  assert.equal(g.web.subrequests, 1, "only feed 3 fetched (card still within its TTL)");
  const xml = await (await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`))).text();
  assert.ok(xml.includes(e.id));
  // A junk ping costs one index read and nothing else.
  g.web.resetCount();
  store.reset();
  assert.equal((await ping(hub, "https://elsewhere.example/feed.atom")).status, 202);
  assert.deepEqual([store.n.kvReads, store.n.reads, g.web.subrequests], [1, 0, 0]);
  // A ping on the policy URL reloads the policy and polls every member.
  g.web.resetCount();
  await ping(hub, POLICY);
  assert.ok(g.web.subrequests >= 11, `${g.web.subrequests} subrequests for a policy ping`);
  // A ping on a member's card URL refetches that card and that feed.
  g.web.resetCount();
  await ping(hub, cardUrl(4));
  assert.equal(g.web.subrequests, 2);
});

test("20 concurrent pings for one feed run at most 2 refreshes, and the state matches one refresh", async () => {
  const g = await buildGroup(3, 2, { etags: true, latencyMs: 20 });
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const before = await status(hub, id);
  const e = await entryFor(0, 50, 0, g.keys[0]);
  g.entries[0].push(e);
  publish(g.web, 0, g.entries[0]);
  const grp = hub.localGroup(id);
  const r0 = grp.stats.refreshes;
  g.web.resetCount();
  await Promise.all(Array.from({ length: 20 }, () => ping(hub, feedUrl(0))));
  assert.ok(grp.stats.refreshes - r0 <= 2, `${grp.stats.refreshes - r0} refreshes`);
  assert.equal(g.web.posted.length, 0, "no subscribers, no pushes");
  const after = await status(hub, id);
  assert.equal(after.entries, before.entries + 1);
  assert.equal(after.rejected.length, before.rejected.length);
  // Pings for different feeds and a full poll at once: refreshes must not interleave, or one
  // refresh's write of the entry list overwrites another's (the lost update of #9).
  const fresh = await Promise.all([0, 1, 2].map((i) => entryFor(i, 60, 0, g.keys[i])));
  fresh.forEach((x, i) => { g.entries[i].push(x); publish(g.web, i, g.entries[i]); });
  await Promise.all([...[0, 1, 2].map((i) => ping(hub, feedUrl(i))), hub.refresh(id)]);
  assert.equal((await status(hub, id)).entries, after.entries + 3);
});

test("key rotation reaches a post even when the member feed answers 304 (ETags on)", async () => {
  const g = await buildGroup(3, 2, { etags: true });
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const k2 = await keyFromSeed(seed(5000));
  const card = JSON.parse(g.web.docs.get(cardUrl(0))!);
  card.capabilities.extensions[0].params.keys = { keys: [k2.publicJwk] };
  g.web.docs.set(cardUrl(0), JSON.stringify(card));
  const post = await entryFor(0, 900, 0, k2);
  g.entries[0].push(post);
  publish(g.web, 0, g.entries[0]);
  tick(5 * 60_000);
  assert.deepEqual(await hub.refresh(id), [], "held while the hub has the old key");
  tick(5 * 60_000);
  assert.deepEqual(await hub.refresh(id), [], "feed now 304, card still within TTL");
  tick(6 * 60_000);
  assert.deepEqual(await hub.refresh(id), [post.id], "accepted after the card TTL, although the feed is unchanged");
});

test("bookkeeping is pruned when an entry leaves its member's feed (diff on 200), without re-logging; reactions stay while their target is retained", async () => {
  const g = await buildGroup(3, 2, { etags: true });
  const { hub, store, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  // A post that breaks policy (summary over the standard preset's 280 characters), and a reaction.
  const bad = await signEntry({ id: "tag:perf.test,2026:a0-bad", updated: later(1), type: "brief.published", title: "x", summary: "s".repeat(300), content: "body" } as RssaEntry, feedUrl(0), g.keys[0]);
  const ack = await signEntry({ id: "tag:perf.test,2026:a1-ack", updated: later(1), type: "reaction", inReplyTo: g.entries[0][0].id, reaction: "ack", title: "ack", summary: "ack" } as RssaEntry, feedUrl(1), g.keys[1]);
  publish(g.web, 0, [...g.entries[0], bad]);
  publish(g.web, 1, [...g.entries[1], ack]);
  tick(60_000);
  await hub.refresh(id);
  assert.ok(store.m.has(`r:${id}:decided:${bad.id}`));
  assert.equal((await status(hub, id)).rejected.filter((r: any) => r.id === bad.id).length, 1);
  const tally = await (await hub.handle(new Request(`https://hub.test/g/${id}/reactions.json`))).json() as any;
  assert.deepEqual(tally[g.entries[0][0].id], { ack: 1 });

  // Both members drop those entries from their feeds and post something new.
  const n0 = await entryFor(0, 60, 0, g.keys[0]);
  const n1 = await entryFor(1, 60, 0, g.keys[1]);
  publish(g.web, 0, [...g.entries[0], n0]);
  publish(g.web, 1, [...g.entries[1], n1]);
  tick(60_000);
  await hub.refresh(id);
  assert.ok(!store.m.has(`r:${id}:decided:${bad.id}`), "the rejected post's record is pruned once its feed no longer serves it");
  assert.equal((await status(hub, id)).rejected.filter((r: any) => r.id === bad.id).length, 1, "and the rejection was not re-logged");
  assert.ok(store.m.has(`r:${id}:react:${ack.id}`), "the reaction is kept while its target is retained");
  const tally2 = await (await hub.handle(new Request(`https://hub.test/g/${id}/reactions.json`))).json() as any;
  assert.deepEqual(tally2[g.entries[0][0].id], { ack: 1 });
});

test("imports a group from the v0.1 KV layout once, with entries, rejections, reactions, subscribers and readers", async () => {
  const g = await buildGroup(3, 2, { etags: true });
  const { hub, store } = setup(g);
  const id = await groupId(POLICY);
  const topic = `https://hub.test/g/${id}/feed.atom`;
  const target = g.entries[0][0];
  const legacy = {
    id, policyUrl: POLICY, entries: [{ ...target, sourceFeed: feedUrl(0), sourceCard: cardUrl(0), acceptedAt: 1, depth: 0, root: target.id }],
    rejected: [{ id: "tag:x,2026:old", feed: feedUrl(2), at: 1, reasons: ["too fast"] }],
    reactions: { [target.id]: { ack: 1 } }, reactionsBy: { "tag:x,2026:r": { target: target.id, reaction: "ack" } },
    decided: { "tag:x,2026:old": "2026-10-06T00:00:00Z", "tag:x,2026:r": "2026-10-06T00:00:00Z" },
    joined: [], members: { [feedUrl(0)]: { feed: feedUrl(0), ok: true, lastFetch: 5, etag: '"e"' } },
  };
  store.m.set(`group:${id}`, JSON.stringify(legacy));
  store.m.set(`card:${feedUrl(0)}`, JSON.stringify({ feed: feedUrl(0), cardUrl: cardUrl(0), keys: [g.keys[0].publicJwk], groups: [POLICY], modules: ["sign"], fetchedAt: 1 }));
  store.m.set(`subs:${topic}`, JSON.stringify([{ callback: "https://sub.example/cb", topic, expires: T0 + 30 * 86_400_000, createdAt: 1 }]));
  store.m.set(`readers:${id}`, JSON.stringify({ "https://reader.example/card.json": T0 }));
  await hub.dir.addGroup(id);
  const imp = (auth = "Bearer x") => hub.handle(new Request(`https://hub.test/g/${id}/import`, { method: "POST", headers: { authorization: auth } }));
  assert.equal((await imp("Bearer wrong")).status, 401);
  const r = await imp();
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { entries: 1, rejected: 1, members: 1, cards: 1, decided: 2, sigRejected: 0, reactions: 1, subscribers: 1, readers: 1 });
  assert.equal((await imp()).status, 500, "a second import is refused");
  const st = await status(hub, id);
  assert.deepEqual(st.gate, { readers: 1, outsideReaders: 1, websubSubscribers: 1 });
  assert.equal(st.rejected.length, 1);
  // The imported group refreshes normally and pushes to the imported subscriber.
  g.web.resetCount();
  const accepted = await hub.refresh(id);
  assert.ok(accepted.length >= 4, `accepted ${accepted.length}`);
  assert.deepEqual(g.web.posted, ["https://sub.example/cb"]);
  const tally = await (await hub.handle(new Request(`https://hub.test/g/${id}/reactions.json`))).json() as any;
  assert.deepEqual(tally[target.id], { ack: 1 });
});

test("budget guards: subscriber cap per group; unknown group ids never reach a group", async () => {
  const g = await buildGroup(2, 1);
  const { hub, store } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const topic = hub.groupFeedUrl(id);
  const sub = (n: number) => hub.websub(new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": `https://sub${n}.example/cb`, "hub.topic": topic }));
  for (let n = 0; n < MAX_SUBSCRIBERS; n++) assert.equal((await sub(n)).status, 202);
  assert.equal((await sub(MAX_SUBSCRIBERS)).status, 429);
  assert.equal((await sub(0)).status, 202, "re-subscribing an existing callback still works");
  assert.equal((await hub.websub(new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": "https://x.example/cb", "hub.topic": "https://elsewhere.example/feed" }))).status, 404);
  const groupsBefore = (hub as any).local.size;
  assert.equal((await hub.handle(new Request("https://hub.test/g/0123456789ab/feed.atom"))).status, 404);
  assert.equal((hub as any).local.size, groupsBefore, "no group instance (in production: no Durable Object) for an unknown id");
  void store;
});
