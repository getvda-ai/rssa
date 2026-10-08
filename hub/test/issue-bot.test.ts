// The issue validator bot (scripts/issue-bot.ts): opt-in parsing and the comment it posts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { comment, targetFrom } from "../../scripts/issue-bot.ts";
import { demoFetch, DEMO_BASE } from "../../scripts/demo-fetch.ts";

test("issue bot: runs only on an explicit validate: line, or the validate label", () => {
  assert.equal(targetFrom("My signature fails.\nvalidate: https://agent.example/.well-known/agent-card.json\nthanks"), "https://agent.example/.well-known/agent-card.json");
  assert.equal(targetFrom("see https://agent.example for details"), undefined, "a bare URL without opt-in is ignored");
  assert.equal(targetFrom("see https://agent.example for details", ["validate"]), "https://agent.example");
  assert.equal(targetFrom("validate: http://insecure.example"), undefined, "https only");
  assert.equal(targetFrom("validate: https://x.example/feed`; rm -rf /`"), "https://x.example/feed", "URL stops at shell metacharacters");
});

test("issue bot: PASS and FAIL comments carry the validator's explanation", async () => {
  const pass = await comment(`${DEMO_BASE}/brewer/.well-known/agent-card.json`, demoFetch());
  assert.match(pass, /PASS/);
  const fail = await comment(`${DEMO_BASE}/brewer/.well-known/agent-card.json`, demoFetch({ [`${DEMO_BASE}/brewer/rssa/feed.atom`]: "<feed>not really</feed>" }));
  assert.match(fail, /FAIL/);
  assert.match(fail, /Validator report/);
});
