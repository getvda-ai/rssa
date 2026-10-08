// The support bot (scripts/issue-bot.ts): when it answers, and what it says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKER, codeBlocks, comment, respond, targetFrom } from "../../scripts/issue-bot.ts";
import { demoFetch, DEMO_BASE } from "../../scripts/demo-fetch.ts";
import { readFileSync } from "node:fs";

const fence = (lang: string, s: string) => "```" + lang + "\n" + s + "\n```";
const site = (p: string) => readFileSync(new URL(`../../demo/site/${p}`, import.meta.url), "utf8");

test("bot: answers only when asked or on-topic with something to check", async () => {
  assert.equal(targetFrom("validate: https://agent.example/.well-known/agent-card.json"), "https://agent.example/.well-known/agent-card.json");
  assert.equal(targetFrom("validate: http://insecure.example"), undefined, "https only");
  assert.equal(targetFrom("validate: https://x.example/feed`; rm -rf /`"), "https://x.example/feed", "URL stops at shell metacharacters");
  assert.equal(await respond({ title: "Docs typo", body: "See https://example.com for the typo." }), undefined, "off-topic issue with a URL: silent");
  assert.equal(await respond({ title: "My signature isn't validating", body: "It just fails, no idea why." }), undefined, "on-topic but nothing to check: silent");
  assert.equal(await respond({ title: "npm install error on Windows", body: "Log:\n" + fence("json", '{"error":"EPERM"}') }), undefined, "off-topic issue with a code block: silent");
  assert.equal(codeBlocks(fence("json", "{}") + "\ntext\n" + fence("", "<feed/>")).length, 2);
});

test("bot: a float in a pasted payload is named, located and fixed (the classic signing failure)", async () => {
  const body = "My signature isn't validating.\n" + fence("json", '{"id":"tag:x,2026:1","updated":"2026-10-08T00:00:00Z","feed":"https://a.example/feed","contentHash":"sha256:00","amount":12.50}');
  const md = (await respond({ title: "Signature fails", body }))!;
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /`float`/);
  assert.match(md, /12\.50/);
  assert.match(md, /languages disagree on how to print decimals/, "the bot's own explanation, not just the parser message");
  assert.match(md, /`\$\.amount` is `12\.50`, which isn't an integer\./, "one plain sentence: what and where");
  assert.doesNotMatch(md, /at offset|\(at \$/, "no parser internals repeated");
});

test("bot: duplicate keys, a non-canonical entry payload, and missing payload fields are explained", async () => {
  const dup = (await respond({ body: "verify fails\n" + fence("json", '{"a":1,"a":2}') }))!;
  assert.match(dup, /duplicate-key/);
  const payload = Buffer.from('{"updated":"2026-10-08T00:00:00Z","id":"tag:x,2026:1"}').toString("base64url");
  const entry = (await respond({ body: "signature problem\n" + fence("json", JSON.stringify({ id: "tag:x,2026:1", payload, sig: "x" })) }))!;
  assert.match(entry, /not canonical/);
  assert.match(entry, /`feed`, `contentHash`/);
});

test("bot: pasted cards, policies and feeds go to the right validator", async () => {
  const card = (await respond({ body: "validate my card please\n" + fence("json", site("brewer/.well-known/agent-card.json")) }, demoFetch()))!;
  assert.match(card, /Pasted Agent Card/);
  const policy = (await respond({ body: "is this policy valid?\n" + fence("json", site("groups/supply-ops/policy.json")) }, demoFetch()))!;
  assert.match(policy, /Pasted group policy/);
  const tampered = site("brewer/rssa/feed.atom").replace("</summary>", " (edited)</summary>");
  const feed = (await respond({ body: "signature verification fails on my feed\n" + fence("xml", tampered) }, demoFetch()))!;
  assert.match(feed, /Pasted feed/);
  assert.match(feed, /❌/);
});

test("bot: a validate: URL gets the full validator report, PASS or FAIL", async () => {
  const pass = await comment(`${DEMO_BASE}/brewer/.well-known/agent-card.json`, demoFetch());
  assert.match(pass, /✅ PASS/);
  const fail = await comment(`${DEMO_BASE}/brewer/.well-known/agent-card.json`, demoFetch({ [`${DEMO_BASE}/brewer/rssa/feed.atom`]: "<feed>not really</feed>" }));
  assert.match(fail, /❌ FAIL/);
});
