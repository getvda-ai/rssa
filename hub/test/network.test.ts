// The agent network (spec/network.md): listing, the three levels, unsigned posts and their limits,
// opt-out, re-checks, and the hub's A2A interface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hub, memoryStore } from "../src/hub.ts";
import { NET_LIMITS, RECHECK_MS, categorise } from "../src/network.ts";
import { keyFromSeed, parseFeed, validateCard, verifyCardSignatures, verifyEntry, withRssa } from "../../packages/sdk-js/src/index.ts";

const BASE = "https://hub.test";
const NET = `${BASE}/network`;
const card = (n: number) => `https://a${n}.example/.well-known/agent-card.json`;
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 0xff);

function web() {
  const docs = new Map<string, string>();
  const fetcher = async (u: string) => {
    const d = docs.get(String(u));
    return d === undefined ? new Response("not found", { status: 404 }) : new Response(d);
  };
  return { docs, fetcher };
}
/** A card with an RSSA extension written by hand (params the SDK's withRssa does not know, as an owner would type them). */
const rawLine = (c: Record<string, unknown>, params: Record<string, unknown>) => ({ ...c, capabilities: { extensions: [{ uri: "https://rssa.getvda.ai/ext/v0.1", required: false, params }] } });
const a2aCard = (n: number, extra: Record<string, unknown> = {}) => ({
  name: `Agent ${n}`, description: "Generates docker compose stacks for redis and postgres", url: `https://a${n}.example/a2a/`,
  provider: { organization: `Org ${n}` }, skills: [{ id: "compose", name: "Compose", tags: ["docker"] }], ...extra,
});

async function setup(opts: { posts?: boolean; fetch?: (u: string) => Promise<Response> } = {}) {
  const w = web();
  let t = Date.parse("2026-10-20T10:00:00Z");
  const key = await keyFromSeed(seed(1));
  const hub = new Hub({ store: memoryStore(), fetch: opts.fetch ?? w.fetcher, now: () => t, adminToken: "x", baseUrl: BASE, networkOptions: { key, groups: { "developer-tools": "https://groups.test/developer-tools/policy.json" }, posts: opts.posts } });
  const call = async (method: string, path: string, body?: unknown, admin = false) => {
    const r = await hub.handle(new Request(`${BASE}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: admin ? { authorization: "Bearer x" } : {} }));
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, json, text };
  };
  const list = (ns: number[]) => call("POST", "/network/admin/list", { agents: ns.map((n) => ({ card: card(n), body: a2aCard(n), source: "test" })) }, true);
  const a2a = async (parts: unknown[]) => (await call("POST", "/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", parts } } })).json;
  return { w, hub, call, list, a2a, key, tick: (ms: number) => { t += ms; } };
}

test("categorise: from the card's own words, at most three, 'other' when nothing matches", () => {
  assert.deepEqual(categorise(a2aCard(1)), ["developer-tools"]);
  assert.deepEqual(categorise({ name: "x", description: "nothing here" }), ["other"]);
  assert.ok(categorise({ name: "security audit trading wallet data", description: "payment" }).length <= 3);
  assert.deepEqual(categorise({ name: "CVE feed", description: "cve alerts" }), ["trust-safety"], "word boundaries are real boundaries");
  assert.deepEqual(categorise({ name: "x", description: "we take no payment" }), ["other"], "'no payment' is not a payments agent");
  assert.deepEqual(categorise({ name: "Bcrypt", skills: [{ id: "crypto" }] }), ["trust-safety"], "crypto alone means cryptography, not web3");
  assert.deepEqual(categorise({ name: "Solana wallet", description: "bitcoin and defi" }), ["crypto-web3"]);
});

test("categorise: real GOSCE cards; their shared selftest skill does not decide the category (2026-10-20 seeding put 96 of 98 in trust-safety)", () => {
  const fx = (h: string) => JSON.parse(readFileSync(new URL(`./fixtures/gosce-${h}.json`, import.meta.url), "utf8"));
  assert.deepEqual(categorise(fx("redis-minio-stack-generator-minio-minio")), ["developer-tools"]);
  assert.deepEqual(categorise(fx("bcrypt-python-jose-d0e0d0")), ["trust-safety"]);
  assert.deepEqual(categorise(fx("auth-token-mcp-service")), ["developer-tools", "trust-safety"]);
});

test("listing: admin only, verified false, signed directory event, hidden fields never invented", async () => {
  const s = await setup();
  assert.equal((await s.call("POST", "/network/admin/list", { agents: [] })).status, 401, "listing needs the admin token");
  const r = await s.list([1, 2]);
  assert.deepEqual(r.json, { added: 2, updated: 0, skipped: 0 });
  assert.deepEqual((await s.list([1])).json, { added: 0, updated: 1, skipped: 0 }, "re-listing updates, never duplicates");
  const all = (await s.call("GET", "/network/agents.json")).json;
  assert.equal(all.listed, 2);
  assert.equal(all.verified, 0);
  assert.ok(all.agents.every((a: any) => a.verified === false && a.level === "listed"));
  assert.equal(all.agents[0].provider, "Org 1", "fields come from the card");
  const one = (await s.call("GET", `/network/agents.json?card=${encodeURIComponent(card(2))}`)).json;
  assert.equal(one.verified, false);
  // The directory feed is signed by the hub key published in the hub's own card.
  const feed = await s.call("GET", "/network/feed.atom");
  const parsed = parseFeed(feed.text);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.cardUrl, `${BASE}/.well-known/agent-card.json`);
  for (const e of parsed.entries) {
    assert.equal(e.type, "agent.listed");
    assert.ok((await verifyEntry(e, `${NET}/feed.atom`, [s.key.publicJwk])).ok, "directory entries verify with the hub key");
  }
});

test("join: needs the network line in the card; read-only member vs poster; validator agrees", async () => {
  const s = await setup();
  await s.list([1, 2]);
  s.w.docs.set(card(1), JSON.stringify(a2aCard(1)));
  const no = await s.call("POST", "/network/join", { card: card(1) });
  assert.equal(no.status, 422);
  assert.deepEqual(no.json.howTo.extension.params, { groups: [NET] }, "the reply carries the exact line to add");
  // Read-only member: groups, no feed.
  s.w.docs.set(card(1), JSON.stringify(withRssa(a2aCard(1), { groups: [NET] })));
  const yes = await s.call("POST", "/network/join", { card: card(1) });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.level, "member");
  assert.equal(yes.json.verified, true);
  // Poster: a feed too.
  s.w.docs.set(card(2), JSON.stringify(withRssa(a2aCard(2), { feed: "https://a2.example/feed.atom", groups: [NET] })));
  const p = await s.call("POST", "/network/join", { card: card(2) });
  assert.equal(p.json.level, "poster");
  assert.match(p.json.next, /groups\.test\/developer-tools/, "a poster is pointed at its category group");
  // An agent nobody listed can join directly.
  s.w.docs.set(card(3), JSON.stringify(withRssa(a2aCard(3), { groups: [NET] })));
  assert.equal((await s.call("POST", "/network/join", { card: card(3) })).json.level, "member");
  // The validator, reading through the hub, sees two-way membership.
  const fetcher = (u: string, i?: RequestInit) => (u.startsWith(BASE) ? s.hub.handle(new Request(u, i)) : s.w.fetcher(u));
  const f = await validateCard(JSON.parse(s.w.docs.get(card(1))!), card(1), { fetcher: fetcher as typeof fetch });
  assert.deepEqual(f.filter((x) => x.code === "membership").map((x) => x.level), ["pass"]);
  const ev = parseFeed((await s.call("GET", "/network/feed.atom")).text).entries.map((e) => e.type);
  assert.equal(ev.filter((t) => t === "agent.joined").length, 3);
});

test("unsigned posts: labelled, kept apart, never 'as' a card (hub 0.7), capped, switchable", async () => {
  const s = await setup();
  await s.list([1]);
  const ok = await s.call("POST", "/network/post", { category: "developer-tools", name: "One", text: "hello from 1" });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.verified, false);
  assert.equal((await s.call("POST", "/network/post", { category: "developer-tools", text: "anonymous" })).status, 201, "anonymous is allowed");
  const xml = (await s.call("GET", "/network/developer-tools/unverified.atom")).text;
  const es = parseFeed(xml).entries;
  assert.equal(es.length, 2);
  assert.ok(es.every((e) => e.type === "post.unverified" && /UNVERIFIED/.test(e.summary ?? "") && !e.sig), "never signed, always labelled");
  assert.match(es.find((e) => e.content === "hello from 1")!.title!, /by @one-/);
  // Posting "as" someone's card is gone, for every card, listed or not, and over A2A too.
  const before = (await s.call("GET", "/network/changes?since=0")).json.latest;
  for (const c of [card(1), "https://never.example/card.json"]) {
    const r = await s.call("POST", "/network/post", { category: "developer-tools", card: c, text: "fake" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /no longer take a card/);
  }
  const a = await s.a2a([{ kind: "data", data: { skill: "post", category: "other", card: card(1), text: "fake" } }]);
  assert.match(a.result.parts[0].text, /Not posted: posts no longer take a card/);
  assert.equal((await s.call("GET", "/network/changes?since=0")).json.latest, before, "nothing was written");
  // Bad input.
  assert.equal((await s.call("POST", "/network/post", { category: "nope", text: "x" })).status, 400);
  assert.equal((await s.call("POST", "/network/post", { category: "other", text: "x".repeat(NET_LIMITS.postChars + 1) })).status, 413);
  // The kill switch.
  const off = await setup({ posts: false });
  assert.equal((await off.call("POST", "/network/post", { category: "other", text: "x" })).status, 503);
});

test("unsigned posts: retention per category", async () => {
  const s = await setup();
  for (let i = 0; i < NET_LIMITS.keepPerCategory + 5; i++) {
    await s.hub.localNetwork().board.post({ category: "other", text: `p${i}` }, `caller ${i}`);
    s.tick(1000);
  }
  const all = (await s.hub.localNetwork().fetch(new Request(`${NET}/other/unverified.atom`), false)).status;
  assert.equal(all, 200);
  const rows = await (s.hub as any).c.store.list("r:network:post:");
  assert.equal(rows.length, NET_LIMITS.keepPerCategory, "the oldest posts beyond the limit are deleted");
});

test("opt-out: anyone stops contact; hiding needs proof from the card's host; members cannot be hidden by others; the operator can restore", async () => {
  const s = await setup();
  await s.list([1, 2, 4, 5]);
  const listed = async () => (await s.call("GET", "/network/agents.json")).json.listed;
  // A live card, and someone who cannot prove they run it: never contacted, still listed.
  s.w.docs.set(card(1), JSON.stringify(a2aCard(1)));
  const weak = await s.call("POST", "/network/optout", { card: card(1) });
  assert.equal(weak.status, 202);
  assert.equal(weak.json.noContact, true);
  assert.equal(weak.json.hidden, false);
  assert.equal(await listed(), 4, "nobody can hide someone else's agent");
  // Proof 1: the card lists this network in params.optout.
  s.w.docs.set(card(1), JSON.stringify(rawLine(a2aCard(1), { optout: [NET] })));
  const proved = await s.call("POST", "/network/optout", { card: card(1) });
  assert.equal(proved.status, 200);
  assert.match(proved.json.proof, /params\.optout/);
  assert.equal(await listed(), 3);
  await s.list([1]);
  assert.equal(await listed(), 3, "re-listing does not undo an opt-out");
  // Proof 2: a file on the card's host.
  s.w.docs.set(card(4), JSON.stringify(a2aCard(4)));
  s.w.docs.set("https://a4.example/.well-known/rssa-optout.txt", `# no network contact\n${NET}\n`);
  assert.equal((await s.call("POST", "/network/optout", { card: card(4) })).status, 200);
  // Another network's URL in the file proves nothing for this one.
  s.w.docs.set(card(5), JSON.stringify(a2aCard(5)));
  s.w.docs.set("https://a5.example/.well-known/rssa-optout.txt", "https://other.example/network\n");
  assert.equal((await s.call("POST", "/network/optout", { card: card(5) })).status, 202);
  // Proof 3: the card is gone. Unknown cards are recorded so they are never listed.
  assert.equal((await s.call("POST", "/network/optout", { card: "https://never.example/card.json" })).status, 200);
  assert.equal(await listed(), 2);
  s.w.docs.set(card(2), JSON.stringify(withRssa(a2aCard(2), { groups: [NET] })));
  await s.call("POST", "/network/join", { card: card(2) });
  assert.equal((await s.call("POST", "/network/optout", { card: card(2) })).status, 409, "a member leaves by editing its own card");
  assert.equal((await s.call("POST", "/network/admin/restore", { card: card(1) }, true)).json.restored, true);
  assert.equal(await listed(), 3);
});

test("safe fetches: the hub reads only public https hosts, follows redirects only within the card's origin, refuses HTML and big bodies", async () => {
  const s = await setup();
  const line = JSON.stringify(withRssa(a2aCard(7), { groups: [NET] }));
  const seen: string[] = [];
  const real = s.w.fetcher;
  s.w.fetcher = undefined as any;
  const fake = async (u: string) => {
    seen.push(String(u));
    if (u === "https://r1.example/card") return new Response(null, { status: 302, headers: { location: "/.well-known/agent-card.json" } });
    if (u === "https://r1.example/.well-known/agent-card.json") return new Response(line, { headers: { "content-type": "application/json" } });
    if (u === "https://r2.example/card") return new Response(null, { status: 301, headers: { location: "https://elsewhere.example/card" } });
    if (u === "https://html.example/card") return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
    if (u === "https://big.example/card") return new Response(new ReadableStream({ start(c) { for (let k = 0; k < 40; k++) c.enqueue(new Uint8Array(10_000)); c.close(); } }));
    return real(u);
  };
  const t = await setup({ fetch: fake });
  assert.equal((await t.call("POST", "/network/join", { card: "https://r1.example/card" })).json.level, "member", "a same-origin redirect is followed");
  const cross = await t.call("POST", "/network/join", { card: "https://r2.example/card" });
  assert.equal(cross.status, 422);
  assert.match(cross.json.error, /redirects to another host/);
  assert.ok(!seen.includes("https://elsewhere.example/card"), "never fetched");
  assert.match((await t.call("POST", "/network/join", { card: "https://html.example/card" })).json.error, /HTML/);
  assert.match((await t.call("POST", "/network/join", { card: "https://big.example/card" })).json.error, /256 kB/);
  for (const bad of ["https://127.0.0.1/card", "https://localhost/card", "https://printer.local/card", "https://[::1]/card"]) {
    assert.match((await t.call("POST", "/network/join", { card: bad })).json.error, /public https hosts/, bad);
  }
  assert.ok(!seen.some((u) => /127\.0\.0\.1|localhost|\.local\/|::1/.test(u)), "local hosts are never fetched");
});

test("recheck: a member whose card drops the line goes back to listed; an unreachable card keeps its verdict", async () => {
  const s = await setup();
  for (const n of [1, 2]) s.w.docs.set(card(n), JSON.stringify(withRssa(a2aCard(n), { groups: [NET] })));
  await s.call("POST", "/network/join", { card: card(1) });
  await s.call("POST", "/network/join", { card: card(2) });
  s.w.docs.set(card(1), JSON.stringify(a2aCard(1)));
  s.w.docs.delete(card(2));
  assert.equal(await s.hub.localNetwork().recheck(), 0, "nothing is due before the interval");
  s.tick(RECHECK_MS);
  assert.equal(await s.hub.localNetwork().recheck(), 2);
  const v = async (n: number) => (await s.call("GET", `/network/agents.json?card=${encodeURIComponent(card(n))}`)).json;
  assert.equal((await v(1)).level, "listed");
  assert.equal((await v(2)).level, "member");
  assert.ok(parseFeed((await s.call("GET", "/network/feed.atom")).text).entries.some((e) => e.type === "agent.left"));
});

test("A2A: signed hub card; message/send with text and data parts; errors are JSON-RPC errors", async () => {
  const s = await setup();
  await s.list([1, 2]);
  const hc = (await s.call("GET", "/.well-known/agent-card.json")).json;
  assert.equal(hc.url, `${BASE}/a2a`);
  assert.deepEqual(hc.skills.map((x: any) => x.id), ["find_agents", "read_group", "join", "post", "profile", "changes", "react", "edit", "delete", "optout", "report"]);
  assert.ok((await verifyCardSignatures(hc, [s.key.publicJwk])).ok, "the hub's card is signed with its key");
  const help = await s.a2a([{ kind: "text", text: "hello?" }]);
  assert.equal(help.result.kind, "message");
  assert.match(help.result.parts[0].text, /join <card URL>/);
  const found = await s.a2a([{ kind: "text", text: "find docker" }]);
  assert.equal(found.result.parts[1].data.total, 2);
  const byCat = await s.a2a([{ kind: "data", data: { skill: "find_agents", category: "developer-tools" } }]);
  assert.equal(byCat.result.parts[1].data.total, 2);
  const posted = await s.a2a([{ kind: "text", text: "post developer-tools: hi from A2A" }]);
  assert.equal(posted.result.parts[1].data.verified, false);
  const read = await s.a2a([{ kind: "text", text: "read developer-tools" }]);
  assert.equal(read.result.parts[1].data.unverified[0].text, "hi from A2A");
  assert.equal(read.result.parts[1].data.signedGroup, "https://groups.test/developer-tools/policy.json");
  s.w.docs.set(card(1), JSON.stringify(withRssa(a2aCard(1), { groups: [NET] })));
  const joined = await s.a2a([{ kind: "data", data: { skill: "join", card: card(1) } }]);
  assert.match(joined.result.parts[0].text, /^Verified/);
  const bad = (await s.call("POST", "/a2a", { jsonrpc: "2.0", id: 7, method: "tasks/get", params: {} })).json;
  assert.equal(bad.error.code, -32601);
  const parse = await s.hub.handle(new Request(`${BASE}/a2a`, { method: "POST", body: "{" }));
  assert.equal((await parse.json() as any).error.code, -32700);
  const doc = (await s.call("GET", "/network")).json;
  assert.equal(doc.type, "rssa-network");
  assert.equal(doc.categories.find((c: any) => c.id === "developer-tools").group, "https://groups.test/developer-tools/policy.json");
});

test("resign: events written before the hub had a key are signed once a key is set", async () => {
  const w = web();
  const store = memoryStore();
  const mk = (key?: Awaited<ReturnType<typeof keyFromSeed>>) => new Hub({ store, fetch: w.fetcher, adminToken: "x", baseUrl: BASE, networkOptions: { key } });
  const before = mk();
  await before.handle(new Request(`${NET}/admin/list`, { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ agents: [{ card: card(1), body: a2aCard(1) }] }) }));
  assert.equal(parseFeed(await (await before.handle(new Request(`${NET}/feed.atom`))).text()).entries[0].sig, undefined);
  const key = await keyFromSeed(seed(2));
  const after = mk(key);
  const r = await after.handle(new Request(`${NET}/admin/resign`, { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" }));
  assert.equal(((await r.json()) as any).signed, 1);
  const e = parseFeed(await (await after.handle(new Request(`${NET}/feed.atom`))).text()).entries[0];
  assert.ok((await verifyEntry(e, `${NET}/feed.atom`, [key.publicJwk])).ok);
});

test("directory events are core types with summaries within 280 characters, so the validator passes the hub's feed clean", async () => {
  const s = await setup();
  await s.call("POST", "/network/admin/list", { agents: [{ card: card(9), body: a2aCard(9, { description: "x".repeat(900) }) }] }, true);
  const e = parseFeed((await s.call("GET", "/network/feed.atom")).text).entries[0];
  assert.ok(e.summary!.length <= 280 && e.summary!.includes(card(9)), "the card URL survives the cut");
  const fetcher = (u: string, i?: RequestInit) => (u.startsWith(BASE) ? s.hub.handle(new Request(u, i)) : s.w.fetcher(u));
  const hubCard = `${BASE}/.well-known/agent-card.json`;
  await s.hub.handle(new Request(`${NET}/join`, { method: "POST", body: JSON.stringify({ card: hubCard }) }));
  const f = await validateCard(JSON.parse((await s.call("GET", "/.well-known/agent-card.json")).text), hubCard, { fetcher: fetcher as typeof fetch });
  assert.deepEqual(f.filter((x) => x.level !== "pass" && x.level !== "info").map((x) => `${x.level} ${x.code}`), []);
});

test("usage counts: per skill and day, distinct callers as hashes, our own tools as self, never raw IPs", async () => {
  const s = await setup();
  const call = (text: string, ip: string, ua: string) => s.hub.handle(new Request(`${BASE}/a2a`, { method: "POST", headers: { "cf-connecting-ip": ip, "user-agent": ua },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m", parts: [{ kind: "text", text }] } } }) }));
  await call("find docker", "1.1.1.1", "agent-a/1");
  await call("find_agents", "1.1.1.1", "agent-a/1");
  await call("hello", "2.2.2.2", "agent-b/1");
  await call("find x", "3.3.3.3", "gosce-rssa-manual");
  await s.hub.handle(new Request(`${NET}/join`, { method: "POST", headers: { "cf-connecting-ip": "4.4.4.4", "user-agent": "agent-c" }, body: JSON.stringify({ card: card(5) }) }));
  const st = (await s.call("GET", "/network/stats.json")).json;
  const d = st.days[0];
  assert.deepEqual(d.calls, { "a2a:find_agents": 2, "a2a:help": 1, "http:join": 1 });
  assert.equal(d.callers, 3, "agent-a counted once");
  assert.equal(d.self, 1);
  assert.ok(!JSON.stringify(st).includes("1.1.1.1"), "no raw IPs");
});
