import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hub, memoryStore } from "../src/hub.ts";
import { demoFetch, DEMO_BASE } from "../../scripts/demo-fetch.ts";
import { keyFromJwk, parseFeed, readFeed, signEntry, atomXml } from "../../packages/sdk-js/src/index.ts";

const POLICY = `${DEMO_BASE}/groups/supply-ops/policy.json`;
const BREWER_FEED = `${DEMO_BASE}/brewer/rssa/feed.atom`;
const memStore = memoryStore;
const site = (p: string) => readFileSync(new URL(`../../demo/site/${p}`, import.meta.url), "utf8");
const keys = JSON.parse(readFileSync(new URL("../../demo/demo-keys.public-on-purpose.json", import.meta.url), "utf8"));

async function setup(overrides: Record<string, string | null> = {}) {
  const store = memStore();
  let t = Date.parse("2026-10-05T12:00:00Z");
  const hub = new Hub({ store, fetch: demoFetch(overrides), now: () => t, adminToken: "secret", baseUrl: "https://hub.test" });
  const g = await hub.register(POLICY);
  return { hub, store, id: g.id, tick: (ms: number) => { t += ms; } };
}

test("hub merges the demo group: 5 entries accepted, the reaction tallied, nothing rejected", async () => {
  const { hub, id } = await setup();
  const accepted = await hub.refresh(id);
  assert.equal(accepted.length, 5);
  const status = await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json();
  assert.deepEqual(status.rejected, []);
  assert.ok(status.members.every((m: any) => m.ok), JSON.stringify(status.members));
  const reactions = await (await hub.handle(new Request(`https://hub.test/g/${id}/reactions.json`))).json();
  assert.deepEqual(reactions, { "tag:demo.rssa.getvda.ai,2026:post-02": { ack: 1 } });
  assert.deepEqual(await hub.refresh(id), [], "second refresh accepts nothing new");
});

test("the merged feed verifies end to end with the plain SDK reader (atom:source attribution)", async () => {
  const { hub, id } = await setup();
  await hub.refresh(id);
  const res = await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`));
  const xml = await res.text();
  const base = demoFetch();
  const fetcher = async (u: string, i?: RequestInit) => (u === `https://hub.test/g/${id}/feed.atom` ? new Response(xml) : base(u, i));
  const read = await readFeed(`https://hub.test/g/${id}/feed.atom`, { fetcher, requireSignatures: true });
  assert.equal(read.entries.length, 5, JSON.stringify(read.problems));
  assert.ok(read.entries.every((e) => e.verified));
  assert.equal(new Set(read.entries.map((e) => e.from)).size, 3, "entries attributed to all three member feeds");
});

test("exact-match filters: ?to= and ?type=", async () => {
  const { hub, id } = await setup();
  await hub.refresh(id);
  const f = parseFeed(await (await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom?to=role:coordinator&type=exception.`))).text());
  assert.deepEqual(f.entries.map((e) => e.type), ["exception.reported"]);
});

test("a tampered entry is rejected with a reason, the rest still merge", async () => {
  const brewer = site("brewer/rssa/feed.atom").replace("Can anyone cover 20 pallets", "Can anyone cover 40 pallets");
  const { hub, id } = await setup({ [BREWER_FEED]: brewer });
  const accepted = await hub.refresh(id);
  const status = await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json();
  assert.equal(status.rejected.length, 1);
  assert.match(status.rejected[0].reasons.join(" "), /summary or content changed/);
  // The question is gone, so the supplier's answer arrives as a reply to an unknown parent — still accepted.
  assert.equal(accepted.length, 4);
});

test("a member whose card does not list the group is not a member (two-way membership)", async () => {
  const card = JSON.parse(site("brewer/.well-known/agent-card.json"));
  card.capabilities.extensions[0].params.groups = [];
  delete card.signatures;
  const { hub, id } = await setup({ [`${DEMO_BASE}/brewer/.well-known/agent-card.json`]: JSON.stringify(card) });
  await hub.refresh(id);
  const status = await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json();
  const m = status.members.find((x: any) => x.feed === BREWER_FEED);
  assert.equal(m.ok, false);
  assert.match(m.problem, /two-way membership/);
});

test("a policy edited after signing is refused; the last good one stays in force", async () => {
  const { hub, id } = await setup();
  await hub.refresh(id);
  const p = JSON.parse(site("groups/supply-ops/policy.json"));
  p.version = 2;
  p.members.push({ feed: "https://intruder.example/feed.atom" });
  const hub2 = new Hub({ store: (hub as any).c.store, fetch: demoFetch({ [POLICY]: JSON.stringify(p) }), now: () => Date.parse("2026-10-05T12:10:00Z"), baseUrl: "https://hub.test" });
  await hub2.refresh(id);
  const status = await (await hub2.handle(new Request(`https://hub.test/g/${id}/status.json`))).json();
  assert.match(status.policyProblem, /policy signature/);
  assert.equal(status.version, 1);
});

test("controls: a reply posted too fast in the same thread is rejected (minInterval PT5M)", async () => {
  const k = await keyFromJwk(keys.brewer);
  const feed = parseFeed(site("brewer/rssa/feed.atom"));
  const fast = await signEntry({
    id: "tag:demo.rssa.getvda.ai,2026:post-07", updated: "2026-10-05T11:31:00Z", type: "brief.published", to: "group",
    inReplyTo: "tag:demo.rssa.getvda.ai,2026:post-03", summary: "Also: please confirm the CoA.", content: "Need CoA PDF.",
  }, BREWER_FEED, k);
  const xml = atomXml({ feedUrl: BREWER_FEED, cardUrl: feed.cardUrl, title: "Brewer" }, [fast, ...feed.entries]);
  const { hub, id } = await setup({ [BREWER_FEED]: xml });
  await hub.refresh(id);
  const status = await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json();
  assert.equal(status.rejected.length, 1);
  assert.match(status.rejected[0].reasons[0], /minInterval/);
});

test("identity grace: card outage keeps the last known key and marks the member stale", async () => {
  const { hub, store, id, tick } = await setup();
  await hub.refresh(id);
  tick(20 * 60_000); // past the 15-minute card TTL
  const down = new Hub({ store, fetch: demoFetch({ [`${DEMO_BASE}/brewer/.well-known/agent-card.json`]: null }), now: () => Date.parse("2026-10-05T12:30:00Z"), baseUrl: "https://hub.test" });
  await down.refresh(id);
  const status = await (await down.handle(new Request(`https://hub.test/g/${id}/status.json`))).json();
  const m = status.members.find((x: any) => x.feed === BREWER_FEED);
  assert.equal(m.ok, true);
  assert.match(m.problem, /identity stale/);
});

test("admin routes need the token; WebSub publish ping refreshes; reader UA counted for the gate", async () => {
  const { hub, id } = await setup();
  assert.equal((await hub.handle(new Request("https://hub.test/groups", { method: "POST", body: "{}" }))).status, 401);
  const ping = await hub.handle(new Request("https://hub.test/", { method: "POST", body: `hub.mode=publish&hub.url=${encodeURIComponent(BREWER_FEED)}` }));
  assert.equal(ping.status, 202, "unknown until first refresh");
  await hub.refresh(id);
  const ping2 = await hub.handle(new Request("https://hub.test/", { method: "POST", body: `hub.mode=publish&hub.url=${encodeURIComponent(BREWER_FEED)}` }));
  assert.equal(ping2.status, 204);
  await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`, { headers: { "user-agent": "rssa-sdk/0.1 reader=https://outsider.example/.well-known/agent-card.json" } }));
  const status = await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json();
  assert.deepEqual(status.gate, { readers: 1, outsideReaders: 1, websubSubscribers: 0 });
});

test("re-reading feeds never re-counts reactions or re-logs rejections (found live, 2026-10-07)", async () => {
  // demoFetch ignores If-None-Match, so every refresh re-parses every member feed — the
  // situation that double-counted a live `ack` and duplicated the rejected log.
  const brewer = site("brewer/rssa/feed.atom").replace("Can anyone cover 20 pallets", "Can anyone cover 40 pallets");
  const { hub, id, tick } = await setup({ [BREWER_FEED]: brewer });
  for (let i = 0; i < 3; i++) { await hub.refresh(id); tick(60_000); }
  const reactions = await (await hub.handle(new Request(`https://hub.test/g/${id}/reactions.json`))).json();
  assert.deepEqual(reactions, { "tag:demo.rssa.getvda.ai,2026:post-02": { ack: 1 } });
  const status = await (await hub.handle(new Request(`https://hub.test/g/${id}/status.json`))).json();
  assert.equal(status.rejected.length, 1, JSON.stringify(status.rejected.map((r: any) => r.id)));
});
