// Tests for the v0.2 additions (docs/DESIGN.md §6): post caps, future-dated entries, the hub budget,
// heartbeats and liveness, key continuity with the identity log, the track record, and ping debouncing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, memoryStore } from "../src/hub.ts";
import { MEMBER_BUDGET } from "../src/group.ts";
import {
  heartbeat, keyFromSeed, readGroup, rotationStatement, signEntry, signPolicy, thumbprint,
  type GroupPolicy, type RssaEntry, type RssaKey,
} from "../../packages/sdk-js/src/index.ts";
import { POLICY, T0, buildGroup, cardUrl, feedUrl, iso, publish, seed, type Group as G } from "../../scripts/synthetic.ts";

const NOW = T0 + 86_400_000;

function setup(g: G) {
  let t = NOW;
  const hub = new Hub({ store: memoryStore(), fetch: g.web.fetcher, now: () => t, adminToken: "x", baseUrl: "https://hub.test" });
  return { hub, tick: (ms: number) => { t += ms; }, now: () => t };
}
const get = async (hub: Hub, id: string, leaf: string) => (await (await hub.handle(new Request(`https://hub.test/g/${id}/${leaf}`))).json()) as any;
const feedXml = async (hub: Hub, id: string) => (await hub.handle(new Request(`https://hub.test/g/${id}/feed.atom`))).text();

/** Re-signs the group policy with changes (the owner's key is seed 99_999 in synthetic.ts). */
async function setPolicy(g: G, patch: Partial<GroupPolicy>) {
  const p = JSON.parse(g.web.docs.get(POLICY)!) as GroupPolicy;
  const { sig: _s, ...rest } = p;
  const next = { ...rest, ...patch, version: p.version + 1 } as GroupPolicy;
  g.web.docs.set(POLICY, JSON.stringify(await signPolicy(next, await keyFromSeed(seed(99_999)))));
}
function setCard(g: G, i: number, params: Record<string, unknown>) {
  const card = JSON.parse(g.web.docs.get(cardUrl(i))!);
  Object.assign(card.capabilities.extensions[0].params, params);
  g.web.docs.set(cardUrl(i), JSON.stringify(card));
}
let serial = 0;
async function post(g: G, i: number, minutesAgo: number, extra: Partial<RssaEntry> = {}, key: RssaKey = g.keys[i]): Promise<RssaEntry> {
  const e: RssaEntry = {
    id: `tag:v02.test,2026:${i}-${serial++}`, updated: iso(NOW - minutesAgo * 60_000), type: "brief.published",
    title: "t", summary: `agent ${i}, ${minutesAgo} minutes ago`, content: "body", ...extra,
  };
  const signed = await signEntry(e, feedUrl(i), key);
  g.entries[i].push(signed);
  publish(g.web, i, g.entries[i]);
  return signed;
}

test("maxPostsPerMember: the 4th post in the window is rejected; reactions and heartbeats are not counted, edits are", async () => {
  const g = await buildGroup(2, 0);
  await setPolicy(g, { overrides: { maxPostsPerMember: 3, rateWindow: "PT1H" } });
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  const p = [await post(g, 0, 50), await post(g, 0, 40), await post(g, 0, 30)];
  const over = await post(g, 0, 20);
  await post(g, 0, 15, { type: "reaction", reaction: "ack", inReplyTo: p[0].id, summary: undefined, content: undefined });
  await post(g, 0, 12, { ...heartbeat("tag:v02.test,2026:hb0", iso(NOW - 12 * 60_000)), summary: undefined, content: undefined });
  const accepted = await hub.refresh(id);
  assert.deepEqual(accepted.sort(), p.map((e) => e.id).sort());
  const st = await get(hub, id, "status.json");
  assert.ok(st.rejected.some((r: any) => r.id === over.id && /maxPostsPerMember/.test(r.reasons.join())), "4th post rejected by the member cap");
  assert.deepEqual(await get(hub, id, "reactions.json"), { [p[0].id]: { ack: 1 } }, "the reaction is tallied, not capped");
  // An edit counts at its new time and no longer at its old one (as a reader without history sees it):
  const i = g.entries[0].findIndex((e) => e.id === p[1].id);
  g.entries[0][i] = await signEntry({ ...p[1], updated: iso(NOW - 5 * 60_000), summary: "edited", payload: undefined, sig: undefined }, feedUrl(0), g.keys[0]);
  publish(g.web, 0, g.entries[0]);
  assert.deepEqual(await hub.refresh(id), [p[1].id], "the edit moves p1 from -40 to -5 minutes");
  // so the window ending at -4 minutes now holds -50, -30 and -5: full.
  const late = await post(g, 0, 4);
  assert.deepEqual(await hub.refresh(id), [], "the edit took a slot");
  assert.ok((await get(hub, id, "status.json")).rejected.some((r: any) => r.id === late.id));
  const tr = (await get(hub, id, "members.json")).members.find((m: any) => m.feed === feedUrl(0));
  assert.equal(tr.accepted, 3);
  assert.equal(tr.edits, 1);
  assert.equal(tr.heartbeats, 1);
  assert.equal(tr.rejected["member-rate"], 2);
  assert.deepEqual(tr.reactionsReceived, { ack: 1 }, "reactions received on its retained entries");
});

test("maxGroupPosts gives the same answer whatever order the members are fetched in, and matches the hubless reader", async () => {
  const results: string[][] = [];
  for (const order of [[0, 1], [1, 0]]) {
    const g = await buildGroup(2, 0);
    serial = 0;
    const a = [await post(g, 0, 50), await post(g, 1, 40), await post(g, 0, 30), await post(g, 1, 20), await post(g, 0, 10)];
    await setPolicy(g, { overrides: { maxGroupPosts: 3, rateWindow: "PT2H" }, members: order.map((i) => ({ feed: feedUrl(i) })) });
    const { hub } = setup(g);
    const { id } = await hub.register(POLICY);
    const accepted = (await hub.refresh(id)).sort();
    assert.deepEqual(accepted, [a[0].id, a[1].id, a[2].id].sort(), `order ${order}: the three earliest`);
    const hubless = await readGroup(POLICY, { fetcher: g.web.fetcher, now: () => NOW });
    assert.deepEqual(hubless.entries.map((e) => e.id).sort(), accepted, "readGroup agrees");
    results.push(accepted);
  }
  assert.deepEqual(results[0], results[1]);
});

test("a future-dated post is held, not rejected, and accepted when its time comes (feed unchanged, ETags on)", async () => {
  const g = await buildGroup(1, 0, { etags: true });
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  const e = await post(g, 0, -60); // an hour ahead of the hub's clock
  assert.deepEqual(await hub.refresh(id), []);
  const st = await get(hub, id, "status.json");
  assert.equal(st.members[0].held, 1);
  assert.equal(st.rejected.length, 0, "held, not logged as a rejection");
  tick(61 * 60_000);
  assert.deepEqual(await hub.refresh(id), [e.id]);
  assert.equal((await get(hub, id, "status.json")).members[0].held, undefined);
});

test("a post dated more than 24 hours ahead is rejected, not held, so its feed goes back to conditional GETs", async () => {
  const g = await buildGroup(1, 0, { etags: true });
  let t = NOW;
  const conditional: boolean[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    if (url === feedUrl(0)) conditional.push(new Headers(init?.headers).has("if-none-match"));
    return g.web.fetcher(url, init);
  };
  const hub = new Hub({ store: memoryStore(), fetch, now: () => t, adminToken: "x", baseUrl: "https://hub.test" });
  const tick = (ms: number) => { t += ms; };
  const { id } = await hub.register(POLICY);
  const e = await post(g, 0, -48 * 60);
  assert.deepEqual(await hub.refresh(id), []);
  const st = await get(hub, id, "status.json");
  assert.equal(st.members[0].held, undefined);
  assert.ok(st.rejected.some((r: any) => r.id === e.id && /24 hours ahead/.test(r.reasons.join())));
  tick(5 * 60_000);
  await hub.refresh(id);
  assert.equal(conditional.at(-1), true, "the next poll is a conditional GET again");
});

test(`the hub budget: past ${MEMBER_BUDGET} accepted entries in an hour (by the hub's clock), the rest wait for the next hour`, async () => {
  const g = await buildGroup(1, 0);
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  // A backdated flood: spaced a minute apart over the past 2+ hours, so no group cap would see a burst.
  for (let k = 0; k < MEMBER_BUDGET + 10; k++) await post(g, 0, 200 - k);
  assert.equal((await hub.refresh(id)).length, MEMBER_BUDGET);
  assert.equal((await get(hub, id, "status.json")).members[0].held, 10);
  tick(5 * 60_000);
  assert.deepEqual(await hub.refresh(id), [], "still within the hour");
  tick(56 * 60_000);
  assert.equal((await hub.refresh(id)).length, 10, "the next hour takes the rest");
});

test("heartbeats: absorbed (never merged or pushed), and liveness goes live → late → silent → live", async () => {
  const g = await buildGroup(2, 0);
  setCard(g, 0, { cadence: "PT1H" });
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.websub(new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": "https://sub.example/cb", "hub.topic": hub.groupFeedUrl(id) }));
  const hbId = "tag:v02.test,2026:heartbeat-0";
  const beat = async (minutesAgo: number) => {
    g.entries[0] = g.entries[0].filter((e) => e.id !== hbId);
    g.entries[0].push(await signEntry(heartbeat(hbId, iso(NOW - minutesAgo * 60_000)), feedUrl(0), g.keys[0]));
    publish(g.web, 0, g.entries[0]);
  };
  await beat(5);
  g.web.resetCount();
  assert.deepEqual(await hub.refresh(id), [], "a heartbeat is not a group entry");
  assert.equal(g.web.posted.length, 0, "and is never pushed to subscribers");
  assert.ok(!(await feedXml(hub, id)).includes(hbId), "not in the merged feed");
  const live = async () => Object.fromEntries((await get(hub, id, "status.json")).members.map((m: any) => [m.feed, m.liveness]));
  assert.deepEqual(await live(), { [feedUrl(0)]: "live", [feedUrl(1)]: "undeclared" });
  tick(70 * 60_000);
  await hub.refresh(id);
  assert.equal((await live())[feedUrl(0)], "late");
  tick(60 * 60_000);
  await hub.refresh(id);
  assert.equal((await live())[feedUrl(0)], "silent");
  await beat(-130); // a fresh heartbeat at the hub's current time (130 minutes after NOW)
  await hub.refresh(id);
  assert.equal((await live())[feedUrl(0)], "live");
});

test("maxCadence: a member that declares no cadence, or a longer one, fails membership", async () => {
  const g = await buildGroup(2, 1);
  setCard(g, 0, { cadence: "PT1H" });
  setCard(g, 1, { cadence: "P1D" });
  await setPolicy(g, { overrides: { maxCadence: "PT6H" } });
  const { hub } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const st = await get(hub, id, "status.json");
  const m1 = st.members.find((m: any) => m.feed === feedUrl(1));
  assert.equal(m1.ok, false);
  assert.match(m1.problem, /longer than this group's maxCadence/);
  assert.equal(m1.liveness, "failing");
  assert.equal(st.members.find((m: any) => m.feed === feedUrl(0)).ok, true);
});

test("key continuity under hold: an unannounced key is held; a rotation statement releases it; the identity log records both", async () => {
  const g = await buildGroup(1, 1);
  await setPolicy(g, { overrides: { keyContinuity: "hold" } });
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const k2 = await keyFromSeed(seed(7001));
  setCard(g, 0, { keys: { keys: [k2.publicJwk] } });
  const e = await post(g, 0, 1, {}, k2);
  tick(16 * 60_000); // past the card TTL
  assert.deepEqual(await hub.refresh(id), [], "held");
  let idn = (await get(hub, id, "identity.json")).members[0];
  assert.equal(idn.held, true);
  assert.deepEqual(idn.history.map((h: any) => h.change), ["first", "held"]);
  assert.match((await get(hub, id, "status.json")).members[0].problem, /unannounced key/);
  // The member publishes the statement, signed by its old key.
  setCard(g, 0, { rotations: [await rotationStatement(cardUrl(0), g.keys[0], k2.publicJwk)] });
  tick(16 * 60_000);
  assert.deepEqual(await hub.refresh(id), [e.id], "released by the statement");
  idn = (await get(hub, id, "identity.json")).members[0];
  assert.equal(idn.held, false);
  assert.deepEqual(idn.history.map((h: any) => h.change), ["first", "held", "rotated"]);
});

test("key continuity under hold: a lost key is recovered by an owner pin in the policy", async () => {
  const g = await buildGroup(1, 1);
  await setPolicy(g, { overrides: { keyContinuity: "hold" } });
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const k3 = await keyFromSeed(seed(7002));
  setCard(g, 0, { keys: { keys: [k3.publicJwk] } });
  const e = await post(g, 0, 1, {}, k3);
  tick(16 * 60_000);
  assert.deepEqual(await hub.refresh(id), [], "held without a statement");
  await setPolicy(g, { overrides: { keyContinuity: "hold" }, members: [{ feed: feedUrl(0), keys: [await thumbprint(k3.publicJwk)] }] });
  tick(60_000); // the card is still within its TTL: the pin alone must release it
  assert.deepEqual(await hub.refresh(id), [e.id]);
  const h = (await get(hub, id, "identity.json")).members[0].history.map((x: any) => x.change);
  assert.deepEqual(h, ["first", "held", "pinned"]);
});

test("key continuity: a key that announces two successors is a fork, and neither successor is trusted", async () => {
  const g = await buildGroup(1, 1);
  await setPolicy(g, { overrides: { keyContinuity: "hold" } });
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const [k4, k5] = [await keyFromSeed(seed(7004)), await keyFromSeed(seed(7005))];
  setCard(g, 0, {
    keys: { keys: [k4.publicJwk] },
    rotations: [await rotationStatement(cardUrl(0), g.keys[0], k4.publicJwk), await rotationStatement(cardUrl(0), g.keys[0], k5.publicJwk)],
  });
  await post(g, 0, 1, {}, k4);
  tick(16 * 60_000);
  assert.deepEqual(await hub.refresh(id), []);
  const idn = (await get(hub, id, "identity.json")).members[0];
  assert.equal(idn.forks.length, 1);
  assert.equal(idn.history.at(-1).change, "fork");
});

test("key continuity under record (standard): a silent change is accepted but logged; an announced one is logged as rotated", async () => {
  const g = await buildGroup(2, 1);
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const [k6, k7] = [await keyFromSeed(seed(7006)), await keyFromSeed(seed(7007))];
  setCard(g, 0, { keys: { keys: [k6.publicJwk] } });
  setCard(g, 1, { keys: { keys: [k7.publicJwk] }, rotations: [await rotationStatement(cardUrl(1), g.keys[1], k7.publicJwk)] });
  const a = await post(g, 0, 1, {}, k6), b = await post(g, 1, 1, {}, k7);
  tick(16 * 60_000);
  assert.deepEqual((await hub.refresh(id)).sort(), [a.id, b.id].sort());
  const idn = await get(hub, id, "identity.json");
  assert.deepEqual(idn.members.map((m: any) => m.history.at(-1).change), ["unannounced", "rotated"]);
  const st = await get(hub, id, "status.json");
  assert.match(st.members[0].problem, /without a rotation statement/);
  assert.equal(st.members[1].problem, undefined);
  const mem = await get(hub, id, "members.json");
  assert.deepEqual(mem.members.map((m: any) => m.keyChanges), [{ announced: 0, unannounced: 1, forks: 0 }, { announced: 1, unannounced: 0, forks: 0 }]);
});

test("pings for one URL are debounced: a burst costs one refetch", async () => {
  const g = await buildGroup(2, 1);
  const { hub, tick } = setup(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const ping = () => hub.websub(new URLSearchParams({ "hub.mode": "publish", "hub.url": feedUrl(0) }));
  g.web.resetCount();
  for (let k = 0; k < 10; k++) await ping();
  assert.equal(g.web.subrequests, 1, "ten sequential pings, one fetch");
  tick(11_000);
  await ping();
  assert.equal(g.web.subrequests, 2, "after the gap, a ping fetches again");
});
