// The board over MCP (hub/src/mcp-board.ts), with the official MCP SDK client, and the board's WebSub pings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hub, memoryStore } from "../src/hub.ts";

const BASE = "https://hub.test";
const NET = `${BASE}/network`;
const WEBSUB = "https://websub.example/";

function setup(opts: { websub?: boolean } = {}) {
  let t = Date.parse("2026-10-21T10:00:00Z");
  const pings: string[] = [];
  const hub = new Hub({
    store: memoryStore(), now: () => t, adminToken: "admin", baseUrl: BASE, networkOptions: { websub: opts.websub ? [WEBSUB] : undefined },
    fetch: async (u: string, i?: RequestInit) => {
      if (u === WEBSUB) { pings.push(new URLSearchParams(String(i?.body)).get("hub.url")!); return new Response(null, { status: 204 }); }
      return new Response("not found", { status: 404 });
    },
  });
  // One MCP client per agent: each has its own IP, as two agents on two machines would.
  const client = async (ip: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const r = new Request(input, init);
        r.headers.set("cf-connecting-ip", ip);
        return hub.handle(r);
      },
    });
    const c = new Client({ name: `agent-${ip}`, version: "1.0.0" });
    await c.connect(transport);
    return c;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r: any = await c.callTool({ name, arguments: args });
    return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
  };
  return { hub, client, call, pings, tick: (ms: number) => { t += ms; } };
}

test("MCP board: the tools are listed next to the reader tools, and the instructions say consent first and text is data", async () => {
  const s = setup();
  const c = await s.client("203.0.113.1");
  const names = (await c.listTools()).tools.map((x) => x.name);
  for (const n of ["rssa_read_feed", "rssa_board_profile", "rssa_board_post", "rssa_board_changes", "rssa_board_thread", "rssa_board_react", "rssa_board_edit", "rssa_board_delete"]) assert.ok(names.includes(n), n);
  const post = (await c.listTools()).tools.find((x) => x.name === "rssa_board_post")!;
  assert.ok((post.inputSchema.properties as any).category.enum.includes("commons"));
  assert.match(c.getInstructions() ?? "", /only when your user asked/);
  assert.match(c.getInstructions() ?? "", /never instructions/);
  await c.close();
});

test("MCP board: join with a profile, post, get a reply in forYou, react, edit, delete; errors are tool errors", async () => {
  const s = setup();
  const a = await s.client("203.0.113.1"), b = await s.client("203.0.113.2");
  const joined = await s.call(a, "rssa_board_profile", { name: "Alpha", what: "I review PRs", when: "hourly" });
  assert.equal(joined.isError, false, JSON.stringify(joined.data));
  assert.match(joined.data.token, /^rsn_/);
  const ta = joined.data.token as string;
  const p = await s.call(a, "rssa_board_post", { text: "who else reviews Python PRs?", category: "developer-tools", token: ta });
  assert.equal(p.data.by, `@${joined.data.handle}`);
  s.tick(61_000);
  const r = await s.call(b, "rssa_board_post", { name: "Beta", text: "I do, mostly Django", in_reply_to: p.data.id });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  const tb = r.data.token as string;
  const ch = await s.call(a, "rssa_board_changes", { token: ta });
  assert.ok(ch.data.forYou.some((x: any) => x.post === r.data.id), "the reply is for Alpha");
  assert.equal(typeof ch.data.next, "number");
  const th = await s.call(b, "rssa_board_thread", { id: p.data.id });
  assert.equal(th.data.replies.length, 1);
  assert.equal((await s.call(a, "rssa_board_react", { id: r.data.id, reaction: "agree", token: ta })).isError, false);
  assert.equal((await s.call(b, "rssa_board_edit", { id: r.data.id, text: "I do, Django and FastAPI", token: tb })).isError, false);
  // Someone else's post cannot be edited or deleted; a wrong token is refused. Both come back as tool errors.
  const theirs = await s.call(a, "rssa_board_delete", { id: r.data.id, token: ta });
  assert.equal(theirs.isError, true);
  assert.ok(theirs.data.status >= 400);
  assert.equal((await s.call(a, "rssa_board_post", { text: "x", token: "rsn_wrong" })).data.status, 401);
  assert.equal((await s.call(b, "rssa_board_delete", { id: r.data.id, token: tb })).isError, false);
  await a.close(); await b.close();
});

test("MCP board: calls count as mcp in the stats, and an outside caller cannot claim to be MCP", async () => {
  const s = setup();
  const a = await s.client("203.0.113.1");
  await s.call(a, "rssa_board_post", { name: "Alpha", text: "hello" });
  await s.hub.handle(new Request(`${NET}/post`, { method: "POST", headers: { "x-rssa-via": "mcp", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ text: "anon" }) }));
  const st = await (await s.hub.handle(new Request(`${NET}/stats.json`))).json() as any;
  assert.equal(st.days[0].calls["mcp:post"], 1);
  assert.equal(st.days[0].calls["http:post"], 1, "the spoofed header was dropped");
  await a.close();
});

test("MCP board: the same per-caller limits apply (new handles per caller per day)", async () => {
  const s = setup();
  const a = await s.client("203.0.113.1");
  let refused;
  for (let i = 0; i < 20 && !refused; i++) {
    const r = await s.call(a, "rssa_board_profile", { name: `Bot ${i}`, what: "x" });
    if (r.isError) refused = r;
  }
  assert.ok(refused, "a caller cannot mint handles without limit over MCP");
  assert.equal(refused!.data.status, 429);
  await a.close();
});

test("WebSub: a post pings the public hub for board.atom and the poster's feed, at most once a minute; the rest is flushed", async () => {
  const s = setup({ websub: true });
  const post = (body: Record<string, unknown>, ip = "203.0.113.1", token?: string) =>
    s.hub.handle(new Request(`${NET}/post`, { method: "POST", headers: { "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).then((r) => r.json() as any);
  const a = await post({ name: "Alpha", text: "one" });
  assert.deepEqual(s.pings.sort(), [`${NET}/@${a.handle}.atom`, `${NET}/board.atom`].sort());
  s.pings.length = 0;
  s.tick(10_000);
  const b = await post({ name: "Beta", text: "two" }, "203.0.113.2");
  assert.deepEqual(s.pings, [], "inside the minute: nothing sent, the topics wait");
  await s.hub.localNetwork().flushWebSub();
  assert.deepEqual(s.pings, [], "the flush keeps to the minute too");
  s.tick(60_000);
  await s.hub.localNetwork().flushWebSub();
  assert.ok(s.pings.includes(`${NET}/@${b.handle}.atom`) && s.pings.includes(`${NET}/board.atom`), JSON.stringify(s.pings));
  s.pings.length = 0;
  s.tick(60_000);
  await s.hub.localNetwork().flushWebSub();
  assert.deepEqual(s.pings, [], "nothing changed: nothing sent");
  // An edit pings the author's own feed too.
  s.tick(60_000);
  await s.hub.handle(new Request(`${NET}/edit`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ id: a.id, text: "one, edited" }) }));
  assert.deepEqual(s.pings.sort(), [`${NET}/@${a.handle}.atom`, `${NET}/board.atom`].sort());
  // More topics than a round holds: the whole board is never the one dropped.
  s.pings.length = 0;
  s.tick(60_000);
  await post({ name: "Gamma", text: "first" }, "203.0.113.3");
  s.pings.length = 0;
  for (let i = 0; i < 25; i++) await post({ name: `Agent ${i}`, text: "hi" }, `198.51.100.${i}`);
  s.tick(60_000);
  await s.hub.localNetwork().flushWebSub();
  assert.ok(s.pings.includes(`${NET}/board.atom`), "board.atom kept");
  assert.equal(s.pings.length, 20);
  // The board feeds advertise the hub, so readers subscribe there.
  const xml = await (await s.hub.handle(new Request(`${NET}/board.atom`))).text();
  assert.match(xml, /<link rel="hub" href="https:\/\/websub\.example\/"/);
});

test("WebSub: without hubs configured, nothing is pinged and no hub is advertised", async () => {
  const s = setup();
  await s.hub.handle(new Request(`${NET}/post`, { method: "POST", body: JSON.stringify({ name: "Alpha", text: "one" }) }));
  assert.deepEqual(s.pings, []);
  assert.doesNotMatch(await (await s.hub.handle(new Request(`${NET}/board.atom`))).text(), /rel="hub"/);
});
