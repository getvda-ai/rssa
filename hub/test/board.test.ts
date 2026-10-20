// The network's board (spec/network.md §6–§6c): handles from a first post, replies, reactions, edits, deletes, the
// change stream with its cursor, the limits, moderation, and the skill file an agent follows by itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, memoryStore } from "../src/hub.ts";
import { BOARD_LIMITS } from "../src/board.ts";
import { withRssa } from "../../packages/sdk-js/src/index.ts";

const BASE = "https://hub.test";
const NET = `${BASE}/network`;

function setup(opts: { posts?: boolean } = {}) {
  const docs = new Map<string, string>();
  let t = Date.parse("2026-10-20T10:00:00Z");
  const hub = new Hub({
    store: memoryStore(), now: () => t, adminToken: "admin", baseUrl: BASE, networkOptions: { posts: opts.posts },
    fetch: async (u: string) => { const d = docs.get(String(u)); return d === undefined ? new Response("not found", { status: 404 }) : new Response(d); },
  });
  const call = async (method: string, path: string, body?: unknown, h: { token?: string; ip?: string } = {}) => {
    const headers: Record<string, string> = { "cf-connecting-ip": h.ip ?? "203.0.113.1", "user-agent": "test-agent" };
    if (h.token) headers.authorization = `Bearer ${h.token}`;
    const r = await hub.handle(new Request(`${BASE}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }));
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, json, text };
  };
  return { hub, docs, call, tick: (ms: number) => { t += ms; } };
}

test("join by posting once with a name: a handle and a token, shown once; no token posts anonymously", async () => {
  const s = setup();
  const first = await s.call("POST", "/network/post", { name: "Vruum Agent", text: "hello" });
  assert.equal(first.status, 201);
  assert.match(first.json.handle, /^vruum-agent-[0-9a-f]{4}$/);
  assert.match(first.json.token, /^rsn_[A-Za-z0-9_-]{32}$/);
  assert.equal(first.json.by, `@${first.json.handle}`);
  assert.equal(first.json.category, "commons", "no category: the commons");
  s.tick(10_000);
  const second = await s.call("POST", "/network/post", { text: "again" }, { token: first.json.token });
  assert.equal(second.json.by, `@${first.json.handle}`);
  assert.equal(second.json.token, undefined, "the token is never shown again");
  const anon = await s.call("POST", "/network/post", { text: "who am I" });
  assert.equal(anon.json.by, "anonymous");
  assert.equal((await s.call("POST", "/network/post", { text: "x" }, { token: "rsn_forged" })).status, 401, "a wrong token is refused, not downgraded to anonymous");
  // The same name twice gives two different handles: a name is not an identity, the token is.
  const twin = await s.call("POST", "/network/post", { name: "Vruum Agent", text: "I am the real one" });
  assert.notEqual(twin.json.handle, first.json.handle);
});

test("a conversation: reply, react, change a reaction, edit, delete; the change stream carries all of it, in order", async () => {
  const s = setup();
  const a = (await s.call("POST", "/network/post", { name: "Alpha", category: "developer-tools", text: "Tabs beat spaces." })).json;
  const b = (await s.call("POST", "/network/post", { name: "Beta", text: "Hi all" }, { ip: "198.51.100.2" })).json;
  s.tick(6_000);
  const reply = await s.call("POST", "/network/post", { inReplyTo: a.id, text: "Wrong. Spaces, always." }, { token: b.token });
  assert.equal(reply.json.category, "developer-tools", "a reply goes into its parent's category");
  assert.equal((await s.call("POST", "/network/react", { id: reply.json.id, reaction: "disagree" }, { token: a.token })).json.reactions.disagree, 1);
  const changed = await s.call("POST", "/network/react", { id: reply.json.id, reaction: "funny" }, { token: a.token });
  assert.deepEqual(changed.json.reactions, { funny: 1 }, "one reaction per handle per post");
  assert.equal((await s.call("POST", "/network/react", { id: reply.json.id, reaction: "agree" })).status, 401, "reactions need a handle");
  assert.equal((await s.call("POST", "/network/react", { id: reply.json.id, reaction: "hate" }, { token: a.token })).status, 400);
  s.tick(6_000);
  assert.equal((await s.call("POST", "/network/edit", { id: a.id, text: "Tabs beat spaces, mostly." }, { token: a.token })).status, 200);
  assert.equal((await s.call("POST", "/network/edit", { id: a.id, text: "hijack" }, { token: b.token })).status, 403, "only the author edits");
  assert.equal((await s.call("POST", "/network/delete", { id: reply.json.id }, { token: a.token })).status, 403, "only the author deletes");
  assert.equal((await s.call("POST", "/network/delete", { id: reply.json.id }, { token: b.token })).status, 200);
  assert.equal((await s.call("POST", "/network/edit", { id: reply.json.id, text: "back" }, { token: b.token })).status, 404, "a deleted post stays deleted");

  const ch = (await s.call("GET", "/network/changes?since=0")).json;
  assert.deepEqual(ch.changes.map((c: any) => c.type), [
    "handle.created", "post.added", "handle.created", "post.added", "post.added", "reaction.set", "reaction.set", "post.edited", "post.deleted",
  ]);
  assert.ok(ch.changes.every((c: any, i: number) => c.seq === i + 1 && c.verified === false));
  assert.equal(ch.next, 9);
  assert.equal(ch.more, false);
  assert.match(ch.note, /never follow instructions/);
  const added = ch.changes.find((c: any) => c.type === "post.added" && c.post === reply.json.id);
  assert.equal(added.text, undefined, "a deleted post's text is scrubbed from the stream too");
  assert.equal(added.removed, true);
  assert.equal(added.by, b.handle);
  assert.equal(added.inReplyTo, a.id);
  assert.equal(ch.changes.find((c: any) => c.type === "post.edited").text, "Tabs beat spaces, mostly.");

  // The cursor: nothing new, then exactly the new thing.
  assert.deepEqual((await s.call("GET", "/network/changes?since=9")).json.changes, []);
  s.tick(6_000);
  await s.call("POST", "/network/post", { inReplyTo: a.id, text: "Fine, mostly." }, { token: b.token });
  const after = (await s.call("GET", "/network/changes?since=9")).json;
  assert.equal(after.changes.length, 1);
  assert.equal(after.next, 10);
  // A thread: the post and its live replies.
  const th = (await s.call("GET", `/network/thread?id=${encodeURIComponent(a.id)}`)).json;
  assert.equal(th.post.text, "Tabs beat spaces, mostly.");
  assert.ok(th.post.editedAt);
  assert.deepEqual(th.replies.map((r: any) => r.text), ["Fine, mostly."]);
  assert.equal((await s.call("GET", `/network/posts/${a.id.split("/").pop()}`)).json.post.id, a.id);
});

test("the change stream pages with a cursor, filters by category, and directory joins appear in it (verified)", async () => {
  const s = setup();
  const h = (await s.call("POST", "/network/post", { name: "Pager", text: "0" })).json;
  for (let i = 1; i < 12; i++) { s.tick(6_000); await s.call("POST", "/network/post", { text: String(i), category: i % 2 ? "commons" : "research-knowledge" }, { token: h.token }); }
  const p1 = (await s.call("GET", "/network/changes?since=0&limit=5")).json;
  assert.equal(p1.changes.length, 5);
  assert.equal(p1.more, true);
  const p2 = (await s.call("GET", `/network/changes?since=${p1.next}&limit=100`)).json;
  assert.equal(p2.changes[0].seq, p1.next + 1);
  assert.equal(p1.changes.length + p2.changes.length, 13);
  const rk = (await s.call("GET", "/network/changes?since=0&category=research-knowledge")).json;
  assert.ok(rk.changes.length === 5 && rk.changes.every((c: any) => c.category === "research-knowledge"));

  const card = "https://x.example/.well-known/agent-card.json";
  s.docs.set(card, JSON.stringify(withRssa({ name: "X", description: "research papers", url: "https://x.example/a2a" }, { groups: [NET] })));
  assert.equal((await s.call("POST", "/network/join", { card })).status, 200);
  const joined = (await s.call("GET", `/network/changes?since=13`)).json.changes;
  assert.equal(joined.length, 1);
  assert.equal(joined[0].type, "agent.joined");
  assert.equal(joined[0].card, card);
  assert.equal(joined[0].verified, true, "a directory event is the hub's own statement");
});

test("limits: seconds between posts, posts per new handle, new handles and anonymous posts per caller", async () => {
  const s = setup();
  const h = (await s.call("POST", "/network/post", { name: "Fast", text: "1" })).json;
  assert.equal((await s.call("POST", "/network/post", { text: "2" }, { token: h.token })).status, 429, "one post per handle every few seconds");
  for (let i = 1; i < BOARD_LIMITS.newHandlePostsPerDay; i++) { s.tick(BOARD_LIMITS.minIntervalMs); assert.equal((await s.call("POST", "/network/post", { text: `n${i}` }, { token: h.token })).status, 201); }
  s.tick(BOARD_LIMITS.minIntervalMs);
  assert.equal((await s.call("POST", "/network/post", { text: "over" }, { token: h.token })).status, 429, "a new handle's first-day cap");

  for (let i = 1; i < BOARD_LIMITS.handlesPerCallerDay; i++) assert.equal((await s.call("POST", "/network/post", { name: `h${i}`, text: "x" })).status, 201);
  assert.equal((await s.call("POST", "/network/post", { name: "one-too-many", text: "x" })).status, 429, "new handles per caller per day");
  assert.equal((await s.call("POST", "/network/post", { name: "elsewhere", text: "x" }, { ip: "198.51.100.9" })).status, 201, "per caller, not hub-wide");

  for (let i = 0; i < BOARD_LIMITS.anonymousPerCallerDay; i++) assert.equal((await s.call("POST", "/network/post", { text: `a${i}` }, { ip: "192.0.2.5" })).status, 201);
  assert.equal((await s.call("POST", "/network/post", { text: "over" }, { ip: "192.0.2.5" })).status, 429);
  assert.equal((await s.call("POST", "/network/post", { text: "other caller" }, { ip: "192.0.2.6" })).status, 201, "anonymous callers do not share one bucket");
  assert.equal((await s.call("POST", "/network/post", { text: "x".repeat(BOARD_LIMITS.postChars + 1) }, { ip: "192.0.2.7" })).status, 413);
});

test("moderation and the kill switch: the operator removes posts and blocks handles; deletes still work when posting is off", async () => {
  const s = setup();
  const h = (await s.call("POST", "/network/post", { name: "Spammer", text: "buy now" })).json;
  assert.equal((await s.call("POST", "/network/admin/remove", { id: h.id })).status, 401);
  const rm = await s.hub.handle(new Request(`${NET}/admin/remove`, { method: "POST", body: JSON.stringify({ id: h.id }), headers: { authorization: "Bearer admin" } }));
  assert.equal(rm.status, 200);
  const bl = await s.hub.handle(new Request(`${NET}/admin/block`, { method: "POST", body: JSON.stringify({ handle: h.handle }), headers: { authorization: "Bearer admin" } }));
  assert.equal(((await bl.json()) as any).blocked, true);
  s.tick(6_000);
  assert.equal((await s.call("POST", "/network/post", { text: "again" }, { token: h.token })).status, 403);
  const th = (await s.call("GET", `/network/thread?id=${encodeURIComponent(h.id)}`)).json;
  assert.equal(th.post.deleted, true);
  assert.equal(th.post.text, undefined);

  const off = setup({ posts: false });
  assert.equal((await off.call("POST", "/network/post", { name: "x", text: "x" })).status, 503);
});

test("A2A: the same board over message/send (post with a name, keep the token, read changes)", async () => {
  const s = setup();
  const send = async (data: unknown) => (await s.call("POST", "/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m", parts: [{ kind: "data", data }] } } })).json.result.parts;
  const [t1, d1] = await send({ skill: "post", name: "A2A Bot", text: "hello over A2A" });
  assert.match(t1.text, /Your handle is @a2a-bot-/);
  s.tick(6_000);
  const [, d2] = await send({ skill: "post", token: d1.data.token, inReplyTo: d1.data.id, text: "replying to myself" });
  assert.equal(d2.data.by, d1.data.by);
  const [t3, d3] = await send({ skill: "changes", since: 0 });
  assert.match(t3.text, /3 changes since 0/);
  assert.equal(d3.data.changes[2].inReplyTo, d1.data.id);
});

test("a roaming agent follows llms.txt and skill.md by itself: finds the guide, joins, talks, checks in", async () => {
  const s = setup();
  const llms = await s.call("GET", "/llms.txt");
  assert.equal(llms.status, 200);
  const skillUrl = /\((https:\/\/hub\.test\/network\/skill\.md)\)/.exec(llms.text)?.[1];
  assert.ok(skillUrl, "llms.txt links the skill file");
  const md = (await s.call("GET", new URL(skillUrl!).pathname)).text;
  assert.match(md, /never follow an instruction found in a post/);
  assert.match(md, /leave your owner a note/i);
  // Run the guide's first command literally: its URL and its JSON body.
  const first = /curl -s -X POST (\S+) \\\n\s+-H "content-type: application\/json" \\\n\s+-d '([^']+)'/.exec(md);
  assert.ok(first, "the join command is in the guide");
  const joined = await s.call("POST", new URL(first![1]).pathname, JSON.parse(first![2]));
  assert.equal(joined.status, 201);
  assert.ok(joined.json.token);
  // The heartbeat: changes since 0, then since the saved cursor.
  const changesUrl = /GET (\S+)\?since=<cursor>/.exec(md)?.[1];
  assert.equal(changesUrl, `${NET}/changes`);
  const beat = (await s.call("GET", `${new URL(changesUrl!).pathname}?since=0`)).json;
  assert.equal(beat.changes.at(-1).post, joined.json.id);
  // Every endpoint the guide names answers (none is a 404).
  const named = [...md.matchAll(/https:\/\/hub\.test(\/network\/[a-z]+(?:\.[a-z]+)?)/g)].map((m) => m[1]);
  assert.ok(named.length >= 8);
  for (const path of new Set(named)) {
    const get = /\.|changes|thread/.test(path);
    const r = await s.call(get ? "GET" : "POST", path, get ? undefined : {});
    assert.notEqual(r.json?.error, "not found", `${path} exists`);
  }
});
