// network.md: read-only member cards (groups, no feed) and the network document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCard, withRssa } from "../src/index.ts";

const CARD = "https://ro.example/.well-known/agent-card.json";
const NET = "https://hub.example/network";
const codes = (f: Array<{ code: string; level: string }>, code: string) => f.filter((x) => x.code === code).map((x) => x.level);

const networkFetcher = (verified: boolean) => async (u: string | URL | Request) => {
  const url = String(u);
  if (url === NET) return new Response(JSON.stringify({ type: "rssa-network", network: NET, name: "Net", agents: `${NET}/agents.json`, join: `${NET}/join` }));
  if (url.startsWith(`${NET}/agents.json?card=`)) {
    assert.equal(decodeURIComponent(url.split("card=")[1]), CARD);
    return new Response(JSON.stringify({ card: CARD, verified }));
  }
  return new Response("not found", { status: 404 });
};

test("a card with groups and no feed is a read-only member, not a failure", async () => {
  const card = withRssa({ name: "ro" }, { groups: [NET] });
  assert.equal("feed" in card.capabilities.extensions[0].params, false, "cardExtension omits an absent feed");
  const f = await validateCard(card, CARD, { deep: false });
  assert.deepEqual(codes(f, "card-readonly"), ["pass"]);
  assert.deepEqual(f.filter((x) => x.level === "fail"), []);
});

test("a card with neither feed nor groups still fails card-feed", async () => {
  const f = await validateCard(withRssa({ name: "x" }, {}), CARD, { deep: false });
  assert.deepEqual(codes(f, "card-feed"), ["fail"]);
});

test("params.unsigned accepts only \"reject\"", async () => {
  const ok = await validateCard(withRssa({ name: "ro" }, { groups: [NET], unsigned: "reject" }), CARD, { deep: false });
  assert.deepEqual(codes(ok, "card-unsigned-posts"), []);
  const bad = await validateCard(withRssa({ name: "ro" }, { groups: [NET], unsigned: "allow" as any }), CARD, { deep: false });
  assert.deepEqual(codes(bad, "card-unsigned-posts"), ["fail"]);
});

test("deep: a network in params.groups is checked against the network's agents list", async () => {
  const card = withRssa({ name: "ro" }, { groups: [NET] });
  const yes = await validateCard(card, CARD, { fetcher: networkFetcher(true) as typeof fetch });
  assert.deepEqual(codes(yes, "membership"), ["pass"]);
  assert.deepEqual(codes(yes, "feed-fetch"), [], "a read-only card has no feed to fetch");
  const no = await validateCard(card, CARD, { fetcher: networkFetcher(false) as typeof fetch });
  assert.deepEqual(codes(no, "membership"), ["warn"]);
  assert.match(no.find((x) => x.code === "membership")!.message, /network\/join/);
});
