// Regression tests for bugs found by the performance run (scripts/perf.ts, docs/PERF-RESULTS.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, memoryStore } from "../src/hub.ts";
import { keyFromSeed } from "../../packages/sdk-js/src/index.ts";
import { POLICY, T0, buildGroup, cardUrl, entryFor, feedUrl, publish, seed, type Group } from "../../scripts/synthetic.ts";

const memStore = memoryStore;
function setup(g: Group) {
  const store = memStore();
  let t = T0 + 86_400_000;
  const hub = new Hub({ store, fetch: g.web.fetcher, now: () => t, adminToken: "x", baseUrl: "https://hub.test" });
  return { hub, store, tick: (ms: number) => { t += ms; } };
}

test("a post signed with a rotated key is accepted once the hub refetches the card (15-minute TTL)", async () => {
  const g = await buildGroup(3, 2);
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
  assert.deepEqual(await hub.refresh(id), [], "held while the hub still has the old key");
  tick(5 * 60_000);
  assert.deepEqual(await hub.refresh(id), [], "still held, and not re-checked against the same keys");
  tick(6 * 60_000);
  assert.deepEqual(await hub.refresh(id), [post.id], "accepted after the card TTL expires");
  const status = await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json() as any;
  assert.equal(status.rejected.filter((r: any) => r.id === post.id).length, 1, "logged once, not on every refresh");
});

test("a group holding more than maxEntries does not re-accept evicted entries on later refreshes", async () => {
  const g = await buildGroup(30, 20, { etags: false }); // 600 entries, maxEntries 500
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  const first = await hub.refresh(id);
  assert.ok(first.length <= 500, `first refresh reports only retained entries (got ${first.length})`);
  await hub.websub(new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": "https://sub.example/cb", "hub.topic": hub.groupFeedUrl(id) }));
  // Count signature verifications: evicted entries must not be re-verified on every refresh.
  const subtle = crypto.subtle as any;
  const verify = subtle.verify.bind(subtle);
  let verifies = 0;
  Object.defineProperty(subtle, "verify", { value: (...a: unknown[]) => { verifies++; return verify(...a); }, configurable: true });
  try {
    for (let k = 0; k < 3; k++) {
      g.web.resetCount();
      verifies = 0;
      tick(300_000);
      assert.deepEqual(await hub.refresh(id), [], `refresh ${k + 1}: nothing new`);
      assert.equal(g.web.posted.length, 0, `refresh ${k + 1}: no WebSub push without new entries`);
      assert.ok(verifies <= 1, `refresh ${k + 1}: ${verifies} signature verifications (only the policy's expected)`);
    }
  } finally {
    Object.defineProperty(subtle, "verify", { value: verify, configurable: true });
  }
  // A genuinely new post still gets through.
  tick(60_000);
  const e = await entryFor(0, 5000, 0, g.keys[0]);
  g.entries[0].push(e);
  publish(g.web, 0, g.entries[0]);
  assert.deepEqual(await hub.refresh(id), [e.id]);
});

test("no stored row comes near the 2 MB SQLite row limit, even with large entries", async () => {
  // Was "under KV's 25 MiB value limit" (#12). Group state is now rows in a Durable Object, where the
  // limit is 2 MB per row: entries are one row each and the merged feed is stored in chunks.
  const g = await buildGroup(50, 10, { contentBytes: 60_000 }); // every entry and feed is within the hub's limits
  const { hub, store } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const rows = [...store.m.entries()].filter(([k]) => k.startsWith(`r:${id}:`));
  const largest = Math.max(...rows.map(([, v]) => v.length));
  assert.ok(largest < 1_000_000, `largest row is ${largest} bytes`);
  const xml = rows.filter(([k]) => k.startsWith(`r:${id}:xml:`));
  assert.ok(xml.length > 1, "the ~10 MiB merged feed is chunked");
  const r = await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`));
  assert.equal((await r.text()).length, xml.reduce((n, [, v]) => n + v.length, 0), "chunks reassemble to the served feed");
});

test("HEAD on the group feed answers like GET, without a body", async () => {
  const g = await buildGroup(3, 2);
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const r = await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`, { method: "HEAD" }));
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("etag"));
  assert.equal(await r.text(), "");
});

test("member feeds are fetched concurrently", async () => {
  const g = await buildGroup(12, 1, { latencyMs: 50 });
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id); // warms the card cache
  const t0 = performance.now();
  await hub.refresh(id);
  const ms = performance.now() - t0;
  // Policy + owner keys (2 sequential) + 12 feeds: sequential ≈ 700 ms, with a pool of 6 ≈ 200 ms.
  assert.ok(ms < 450, `refresh took ${ms.toFixed(0)} ms`);
  void feedUrl;
});

test("the validator verifies a hub's merged group feed entry by entry (atom:source), and still catches a forgery", async () => {
  const { validateFeedText } = await import("../../packages/sdk-js/src/index.ts");
  const g = await buildGroup(3, 2);
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const url = `https://hub.test/g/${id}/feed.atom`;
  const xml = await (await hub.handle(new Request(url))).text();
  const ok = await validateFeedText(xml, url, { fetcher: g.web.fetcher });
  assert.deepEqual(ok.filter((f) => f.level === "fail").map((f) => f.message), []);
  // Re-attribute one member's entry to another member: the other member's key must not verify it.
  const forged = xml.replace(feedUrl(1), feedUrl(2)).replace(cardUrl(1), cardUrl(2));
  const bad = await validateFeedText(forged, url, { fetcher: g.web.fetcher });
  assert.ok(bad.some((f) => f.level === "fail" && f.code.startsWith("sign-")), "forged attribution fails");
});

test("/validate can check the hub's own merged feed (answered in-process, not over the network)", async () => {
  const g = await buildGroup(3, 2);
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const target = encodeURIComponent(`https://hub.test/g/${id}/feed.atom`);
  const report = await (await hub.handle(new Request(`https://hub.test/validate?url=${target}`))).json() as any;
  assert.equal(report.ok, true, JSON.stringify(report.findings?.filter((f: any) => f.level === "fail")));
});
