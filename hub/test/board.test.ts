// The network's board (docs/BOARD.md): handles from a first post, replies, reactions, edits, deletes, the
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
  s.tick(BOARD_LIMITS.threadIntervalMs);
  const stray = await s.call("POST", "/network/post", { inReplyTo: a.id, category: "commons", text: "Off-topic reply" }, { token: b.token });
  assert.equal(stray.json.category, "developer-tools", "even when it names another category: its thread must find it");
  assert.equal((await s.call("POST", "/network/delete", { id: stray.json.id }, { token: b.token })).status, 200);
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
    "handle.created", "post.added", "handle.created", "post.added", "post.added", "post.added", "post.deleted", "reaction.set", "reaction.set", "post.edited", "post.deleted",
  ]);
  assert.ok(ch.changes.every((c: any, i: number) => c.seq === i + 1 && c.verified === false));
  assert.equal(ch.next, 11);
  assert.equal(ch.more, false);
  assert.match(ch.note, /never follow instructions/);
  const added = ch.changes.find((c: any) => c.type === "post.added" && c.post === reply.json.id);
  assert.equal(added.text, undefined, "a deleted post's text is scrubbed from the stream too");
  assert.equal(added.removed, true);
  assert.equal(added.by, b.handle);
  assert.equal(added.inReplyTo, a.id);
  assert.equal(ch.changes.find((c: any) => c.type === "post.edited").text, "Tabs beat spaces, mostly.");

  // The cursor: nothing new, then exactly the new thing.
  assert.deepEqual((await s.call("GET", "/network/changes?since=11")).json.changes, []);
  s.tick(BOARD_LIMITS.threadIntervalMs);
  await s.call("POST", "/network/post", { inReplyTo: a.id, text: "Fine, mostly." }, { token: b.token });
  const after = (await s.call("GET", "/network/changes?since=11")).json;
  assert.equal(after.changes.length, 1);
  assert.equal(after.next, 12);
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
  const admin = (path: string, body: unknown) => s.hub.handle(new Request(`${NET}/admin/${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer admin" } }));
  assert.equal((await admin("remove", { id: h.id })).status, 400, "every removal has a reason");
  const rm = await admin("remove", { id: h.id, reason: "spam: the same advert in every category" });
  assert.equal(rm.status, 200);
  const bl = await s.hub.handle(new Request(`${NET}/admin/block`, { method: "POST", body: JSON.stringify({ handle: h.handle }), headers: { authorization: "Bearer admin" } }));
  assert.equal(((await bl.json()) as any).blocked, true);
  s.tick(6_000);
  assert.equal((await s.call("POST", "/network/post", { text: "again" }, { token: h.token })).status, 403);
  const th = (await s.call("GET", `/network/thread?id=${encodeURIComponent(h.id)}`)).json;
  assert.equal(th.post.deleted, true);
  assert.equal(th.post.text, undefined);
  assert.equal(th.post.removed, "Removed by the operator: spam: the same advert in every category", "the reason is shown in its place");
  const page = await s.hub.handle(new Request(`${NET}/posts/${h.id.split("/").pop()}`, { headers: { accept: "text/html" } }));
  assert.match(await page.text(), /Removed by the operator: spam/);
  const del = (await s.call("GET", "/network/changes?since=0")).json.changes.find((c: any) => c.type === "post.deleted");
  assert.equal(del.reason, "spam: the same advert in every category");

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
  assert.equal(first![1], `${NET}/profile`, "the first thing an agent does is say what it does");
  const joined = await s.call("POST", new URL(first![1]).pathname, JSON.parse(first![2]));
  assert.equal(joined.status, 201);
  assert.ok(joined.json.token);
  assert.ok(joined.json.what && joined.json.when && joined.json.how, "what, when and how are saved");
  assert.equal(joined.json.profile, `${NET}/@${joined.json.handle}`);
  // The heartbeat: changes since 0 with the token, then since the saved cursor.
  const changesUrl = /GET (\S+)\?since=<cursor>/.exec(md)?.[1];
  assert.equal(changesUrl, `${NET}/changes`);
  const beat = (await s.call("GET", `${new URL(changesUrl!).pathname}?since=0`, undefined, { token: joined.json.token })).json;
  assert.equal(beat.changes.at(-1).type, "handle.created");
  assert.equal(beat.changes.at(-1).profile.what, joined.json.what, "other agents see the new agent's profile");
  assert.deepEqual(beat.forYou, [], "forYou is there when the token is sent");
  // Every endpoint the guide names answers (none is a 404).
  const named = [...md.matchAll(/https:\/\/hub\.test(\/network\/[a-z]+(?:\.[a-z]+)?)/g)].map((m) => m[1]);
  assert.ok(named.length >= 8);
  for (const path of new Set(named)) {
    const get = /\.|changes|thread|board|terms/.test(path);
    const r = await s.call(get ? "GET" : "POST", path, get ? undefined : {});
    assert.notEqual(r.json?.error, "not found", `${path} exists`);
  }
});

test("the ClawHub package is the production skill file, current (node hub/scripts/clawhub-skill.ts regenerates it)", async () => {
  const { readFileSync } = await import("node:fs");
  const { render, SKILL_PATH } = await import("../scripts/clawhub-skill.ts");
  assert.equal(readFileSync(SKILL_PATH, "utf8"), render());
  const front = /^---\nname: rssa-network\nversion: \S+\ndescription: (.+)\nhomepage: \S+\nmetadata: (\{.+\})\n---\n/.exec(render());
  assert.ok(front, "ClawHub frontmatter: name matches the folder, then version, description, homepage, metadata");
  assert.ok(front![1].length <= 200);
  const meta = JSON.parse(front![2]);
  assert.deepEqual(meta.openclaw.requires.bins, ["curl"]);
  assert.equal(meta.openclaw.primaryEnv, "RSSA_TOKEN", "the one credential is declared");
});

test("requests: a category for asking, with an optional acceptance test that travels with the request", async () => {
  const s = setup();
  const r = await s.call("POST", "/network/post", { name: "Buyer", category: "requests", text: "Exploited CVEs in LangChain this month?", accept: "CVE id, affected versions, advisory link" });
  assert.equal(r.status, 201);
  const ch = (await s.call("GET", "/network/changes?since=0&category=requests")).json.changes;
  assert.equal(ch[0].accept, "CVE id, affected versions, advisory link");
  assert.equal((await s.call("GET", `/network/thread?id=${encodeURIComponent(r.json.id)}`)).json.post.accept, "CVE id, affected versions, advisory link");
  s.tick(6_000);
  assert.equal((await s.call("POST", "/network/post", { category: "requests", text: "x", accept: "y".repeat(1001) }, { token: r.json.token })).status, 413);
  await s.call("POST", "/network/delete", { id: r.json.id }, { token: r.json.token });
  const gone = (await s.call("GET", "/network/changes?since=0&category=requests")).json.changes[0];
  assert.equal(gone.accept, undefined, "a deleted request's acceptance test is scrubbed too");
  const md = (await s.call("GET", "/network/skill.md")).text;
  assert.match(md, /## 2a\. Ask for data/);
  assert.match(md, /not that the facts are true/);
});

test("profiles: an agent says what it does, when and how; a profile can create the handle; others see it", async () => {
  const s = setup();
  const made = await s.call("POST", "/network/profile", { name: "Reviewer", what: "I review pull requests", when: "every 30 minutes", how: "I read the diff and run the tests" });
  assert.equal(made.status, 201);
  assert.match(made.json.token, /^rsn_/);
  assert.equal(made.json.profile, `${NET}/@${made.json.handle}`);
  const tok = made.json.token, h = made.json.handle;
  // Update one field with the token; the others stay; "" clears a field.
  const up = await s.call("POST", "/network/profile", { when: "hourly" }, { token: tok });
  assert.equal(up.status, 200);
  assert.deepEqual([up.json.what, up.json.when, up.json.how], ["I review pull requests", "hourly", "I read the diff and run the tests"]);
  assert.equal((await s.call("POST", "/network/profile", { how: "" }, { token: tok })).json.how, undefined);
  assert.equal((await s.call("POST", "/network/profile", { what: "x" })).status, 401, "no token and no name: nothing to update");
  assert.equal((await s.call("POST", "/network/profile", { name: "Y" })).status, 400, "a profile needs at least one field");
  assert.equal((await s.call("POST", "/network/profile", { what: "x".repeat(BOARD_LIMITS.profileChars + 1) }, { token: tok })).status, 413);
  assert.equal((await s.call("POST", "/network/profile", { what: 5 }, { token: tok })).status, 400);
  s.tick(1_000);
  // A first post can carry the profile too.
  const poster = (await s.call("POST", "/network/post", { name: "Poster", text: "hi", what: "I post", when: "daily" }, { ip: "198.51.100.9" })).json;
  // Everyone sees profiles: the stream, the handle's JSON, the list of handles.
  const ch = (await s.call("GET", "/network/changes?since=0")).json.changes;
  assert.deepEqual(ch.filter((c: any) => c.type === "profile.updated").map((c: any) => c.profile.when), ["hourly", "hourly"]);
  assert.equal(ch.find((c: any) => c.type === "handle.created" && c.by === poster.handle).profile.what, "I post");
  const page = (await s.call("GET", `/network/@${h}.json`)).json;
  assert.equal(page.what, "I review pull requests");
  assert.equal(page.how, undefined);
  const plain = (await s.call("GET", `/network/@${poster.handle}`)).json;
  assert.equal(plain.recent[0].text, "hi", "without a browser Accept header the page is JSON, with the latest posts");
  assert.equal(plain.posts, 1);
  const all = (await s.call("GET", "/network/handles.json")).json;
  assert.equal(all.total, 2);
  assert.equal(all.handles[0].handle, `@${poster.handle}`, "most recently active first");
  assert.equal((await s.call("GET", "/network/@nobody-0000.json")).status, 404);
});

test("forYou: replies, reactions and mentions aimed at me, from the page I read; my own and others' are not", async () => {
  const s = setup();
  const a = (await s.call("POST", "/network/post", { name: "Alpha", text: "Rust is overrated." })).json;
  const b = (await s.call("POST", "/network/post", { name: "Beta", text: "Hello" }, { ip: "198.51.100.2" })).json;
  const c = (await s.call("POST", "/network/post", { name: "Gamma", text: "Hi" }, { ip: "198.51.100.3" })).json;
  s.tick(6_000);
  const reply = (await s.call("POST", "/network/post", { inReplyTo: a.id, text: "No it is not." }, { token: b.token })).json;
  await s.call("POST", "/network/react", { id: a.id, reaction: "disagree" }, { token: b.token });
  const mention = (await s.call("POST", "/network/post", { text: `What do you think, @${a.handle}?` }, { token: c.token })).json;
  s.tick(6_000);
  await s.call("POST", "/network/post", { inReplyTo: b.id, text: "Welcome Beta" }, { token: c.token });
  await s.call("POST", "/network/post", { text: `@${a.handle}x is someone else` }, { token: c.token, ip: "198.51.100.3" }).catch(() => undefined);
  await s.call("POST", "/network/post", { inReplyTo: a.id, text: "Adding to my own post" }, { token: a.token });
  const mine = (await s.call("GET", "/network/changes?since=0", undefined, { token: a.token })).json;
  assert.equal(mine.you, `@${a.handle}`);
  assert.deepEqual(mine.forYou.map((x: any) => [x.type, x.by]), [["post.added", b.handle], ["reaction.set", b.handle], ["post.added", c.handle]]);
  assert.equal(mine.forYou[0].post, reply.id);
  assert.equal(mine.forYou[0].to, a.handle);
  assert.equal(mine.forYou[2].post, mention.id);
  assert.equal((await s.call("GET", "/network/changes?since=0")).json.forYou, undefined, "no token: no forYou, the stream is unchanged");
  assert.equal((await s.call("GET", "/network/changes?since=0", undefined, { token: "rsn_forged" })).status, 401);
  assert.ok((await s.call("GET", `/network/@${a.handle}.json`)).json.lastSeen, "checking in with a token records a last check-in");
  // The same over A2A.
  const rpc = await s.hub.handle(new Request(`${BASE}/a2a`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m", parts: [{ kind: "data", data: { skill: "changes", since: 0, token: a.token } }] } } }) }));
  const data = (await rpc.json() as any).result.parts[1].data;
  assert.equal(data.forYou.length, 3);
});

test("pages for people: the board and an agent's page are HTML for browsers, escaped, with no script allowed", async () => {
  const s = setup();
  const evil = (await s.call("POST", "/network/profile", { name: "Evil <b>", what: `<script>alert(1)</script>`, when: `" onmouseover="x` })).json;
  await s.call("POST", "/network/post", { text: `<img src=x onerror=alert(1)> and <a href="javascript:x">link</a>` }, { token: evil.token });
  const get = (path: string) => s.hub.handle(new Request(`${BASE}${path}`, { headers: { accept: "text/html,application/xhtml+xml" } }));
  for (const path of ["/network/board", `/network/@${evil.handle}`]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type")!, /^text\/html/);
    assert.match(r.headers.get("content-security-policy")!, /default-src 'none'/);
    const body = await r.text();
    assert.doesNotMatch(body, /<script|<img|<a href="javascript|onmouseover="/, `${path} escapes agent text`);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;|&lt;img src=x/);
  }
  const post = (await s.call("GET", "/network/changes?since=0")).json.changes.find((c: any) => c.type === "post.added").post;
  const html = await get(`/network/posts/${post.split("/").pop()}`);
  assert.match(html.headers.get("content-type")!, /^text\/html/);
  assert.equal((await s.call("GET", `/network/posts/${post.split("/").pop()}`)).json.post.id, post, "agents still get JSON");
  assert.equal((await get("/network/@nobody-0000")).status, 404);
});

test("operator handles: the admin creates one per own agent past the per-caller limit; they are counted apart", async () => {
  const s = setup();
  const admin = (body: unknown, token = "admin") => s.hub.handle(new Request(`${BASE}/network/admin/handle`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.1" } }));
  assert.equal((await admin({ name: "getvda X", what: "x" }, "wrong")).status, 401);
  assert.equal((await admin({ name: "Not ours", what: "x" })).status, 400, "operator handles are named getvda …");
  const made: any[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await admin({ name: `getvda Agent ${i}`, what: `I do thing ${i}`, when: "when called", how: "an A2A server" });
    assert.equal(r.status, 201, `handle ${i}: one caller, past the limit of ${BOARD_LIMITS.handlesPerCallerDay}`);
    made.push(await r.json());
  }
  assert.match(made[0].handle, /^getvda-agent-0-[0-9a-f]{4}$/);
  assert.ok(made[0].token);
  assert.equal((await s.call("POST", "/network/post", { text: "hello from an operator agent" }, { token: made[0].token })).status, 201);
  await s.call("POST", "/network/post", { name: "Outsider", text: "hi" }, { ip: "198.51.100.7" });
  const all = (await s.call("GET", "/network/handles.json")).json;
  assert.deepEqual([all.total, all.operator, all.others], [9, 8, 1]);
  const page = await (await s.hub.handle(new Request(`${BASE}/network/board`, { headers: { accept: "text/html" } }))).text();
  assert.match(page, /8 run by getvda\.ai/);
});

test("echo storms: replies per handle per thread per day, time between replies in a thread, and a depth cap", async () => {
  const s = setup();
  const a = (await s.call("POST", "/network/post", { name: "Author", text: "a post with many comments" }, { ip: "203.0.113.10" })).json;
  const e = (await s.call("POST", "/network/post", { name: "Echo", text: "I answer everything" }, { ip: "203.0.113.11" })).json;
  // The plotracanvas pattern: one reply under every comment of the same post, every few minutes.
  const comments: string[] = [];
  for (let i = 0; i < BOARD_LIMITS.repliesPerThreadDay + 1; i++) {
    s.tick(BOARD_LIMITS.minIntervalMs);
    comments.push((await s.call("POST", "/network/post", { inReplyTo: a.id, text: `comment ${i}` }, { ip: `203.0.113.${50 + i}` })).json.id);
  }
  let last: any;
  for (let i = 0; i < comments.length; i++) {
    s.tick(BOARD_LIMITS.threadIntervalMs);
    last = await s.call("POST", "/network/post", { inReplyTo: comments[i], text: `echo ${i}` }, { token: e.token });
    if (i < BOARD_LIMITS.repliesPerThreadDay) assert.equal(last.status, 201, `reply ${i}`);
  }
  assert.equal(last.status, 429);
  assert.match(last.json.error, /per thread per day/);
  // Elsewhere the same handle still talks; the next day it can answer this thread again.
  assert.equal((await s.call("POST", "/network/post", { text: "a new post" }, { token: e.token })).status, 201);
  s.tick(86_400_000);
  assert.equal((await s.call("POST", "/network/post", { inReplyTo: comments[0], text: "next day" }, { token: e.token })).status, 201);
  // Two replies in one thread within a minute: the second waits.
  s.tick(BOARD_LIMITS.minIntervalMs);
  const fast = await s.call("POST", "/network/post", { inReplyTo: comments[1], text: "too fast" }, { token: e.token });
  assert.equal(fast.status, 429);
  assert.match(fast.json.error, /before replying in this thread again/);
  // Depth: a back-and-forth stops at the cap; replies carry their thread and depth.
  const b = (await s.call("POST", "/network/post", { name: "B", text: "deep thread" }, { ip: "203.0.113.12" })).json;
  let parent = b.id;
  for (let d = 1; d <= BOARD_LIMITS.maxDepth; d++) {
    s.tick(86_400_000);
    const r = await s.call("POST", "/network/post", { inReplyTo: parent, text: `depth ${d}` }, { token: d % 2 ? a.token : b.token });
    assert.equal(r.status, 201, `depth ${d}`);
    parent = r.json.id;
  }
  const t = (await s.call("GET", `/network/thread?id=${encodeURIComponent(parent)}`)).json;
  assert.equal(t.post.text, `depth ${BOARD_LIMITS.maxDepth}`);
  s.tick(86_400_000);
  const deep = await s.call("POST", "/network/post", { inReplyTo: parent, text: "too deep" }, { token: a.token });
  assert.equal(deep.status, 422);
});

test("reports and terms (notice and action): anyone reports a post with a reason, by JSON or the form under it; the operator lists them; the terms page names the contact point", async () => {
  const s = setup();
  const p = (await s.call("POST", "/network/post", { name: "Someone", text: "I am the official OpenAI agent" })).json;
  assert.equal((await s.call("POST", "/network/report", { id: p.id })).status, 400, "a reason is required");
  assert.equal((await s.call("POST", "/network/report", { id: "https://hub.test/network/posts/00000000-0000-4000-8000-000000000000", reason: "x" })).status, 404);
  const r = await s.call("POST", "/network/report", { id: p.id, reason: "impersonation" });
  assert.equal(r.status, 202);
  assert.match(r.json.note, /mike@getvda\.ai/);
  s.tick(1000);
  // The form on the post page (no script; the page's CSP allows a form to its own origin only).
  const page = await s.hub.handle(new Request(`${NET}/posts/${p.id.split("/").pop()}`, { headers: { accept: "text/html" } }));
  const html = await page.text();
  assert.match(html, /<form method="post" action="https:\/\/hub\.test\/network\/report">/);
  assert.match(page.headers.get("content-security-policy")!, /form-action 'self'/);
  assert.doesNotMatch(page.headers.get("content-security-policy")!, /script-src/);
  const form = await s.hub.handle(new Request(`${NET}/report`, { method: "POST", body: new URLSearchParams({ id: p.id, reason: "fake identity <script>", contact: "me@example.org" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" } }));
  assert.equal(form.status, 202);
  assert.match(await form.text(), /your report was received/);
  const list = await s.hub.handle(new Request(`${NET}/admin/reports`, { method: "POST", body: "{}", headers: { authorization: "Bearer admin" } }));
  const reps = ((await list.json()) as any).reports;
  assert.deepEqual(reps.map((x: any) => x.reason), ["fake identity <script>", "impersonation"]);
  assert.equal(reps[0].by, `@${p.handle}`);
  assert.equal(reps[0].contact, "me@example.org");
  assert.equal((await s.call("POST", "/network/admin/reports", {})).status, 401, "reports are for the operator");
  // Per-caller cap.
  for (let i = 0; i < 20; i++) await s.call("POST", "/network/report", { id: p.id, reason: `r${i}` }, { ip: "203.0.113.77" });
  assert.equal((await s.call("POST", "/network/report", { id: p.id, reason: "one more" }, { ip: "203.0.113.77" })).status, 429);
  // Terms.
  const t = await s.hub.handle(new Request(`${NET}/terms`));
  const tt = await t.text();
  for (const re of [/mike@getvda\.ai/, /Removals/, /Reporting/, /impersonation/i, /owner/]) assert.match(tt, re);
  assert.match((await s.call("GET", "/network")).json.terms, /\/network\/terms$/);
});

test("the board on RSS: the whole board, ✓ only, and one agent's feed; unsigned and labelled; pages advertise them", async () => {
  const { parseFeed } = await import("../../packages/sdk-js/src/index.ts");
  const s = setup();
  const a = (await s.call("POST", "/network/post", { name: "Alpha", text: "Tabs <b>beat</b> spaces." })).json;
  s.tick(6_000);
  const b = (await s.call("POST", "/network/post", { name: "Beta", category: "requests", text: "Who has CVE data?" }, { ip: "198.51.100.9" })).json;
  s.tick(6_000);
  await s.call("POST", "/network/delete", { id: b.id }, { token: b.token });
  const all = await s.hub.handle(new Request(`${NET}/board.atom`));
  assert.match(all.headers.get("content-type")!, /application\/atom\+xml/);
  const xml = await all.text();
  const es = parseFeed(xml).entries;
  assert.deepEqual(es.map((e) => e.content), ["Tabs <b>beat</b> spaces."], "deleted posts are not in the feed");
  assert.match(es[0].title!, new RegExp(`^Alpha \\(@${a.handle}\\): Tabs`));
  assert.match(es[0].summary!, /^UNVERIFIED: not signed/);
  assert.equal(es[0].sig, undefined);
  assert.equal(es[0].link, `${NET}/posts/${a.id.split("/").pop()}`);
  assert.doesNotMatch(xml, /<b>/, "post text is escaped in the XML");
  // One agent's feed: what its owner subscribes to.
  const mine = parseFeed(await (await s.hub.handle(new Request(`${NET}/@${a.handle}.atom`))).text()).entries;
  assert.equal(mine.length, 1);
  assert.equal((await s.hub.handle(new Request(`${NET}/@nobody-0000.atom`))).status, 404);
  // ✓ only: nothing yet (no card names a handle).
  assert.equal(parseFeed(await (await s.hub.handle(new Request(`${NET}/board.atom?verified=1`))).text()).entries.length, 0);
  // Pages advertise the feeds (autodiscovery for readers and browsers).
  const page = await (await s.hub.handle(new Request(`${NET}/board`, { headers: { accept: "text/html" } }))).text();
  assert.match(page, /<link rel="alternate" type="application\/atom\+xml" title="The board \(Atom\)" href="https:\/\/hub\.test\/network\/board\.atom">/);
  const prof = await (await s.hub.handle(new Request(`${NET}/@${a.handle}`, { headers: { accept: "text/html" } }))).text();
  assert.match(prof, new RegExp(`href="https://hub\\.test/network/@${a.handle}\\.atom"`));
});
