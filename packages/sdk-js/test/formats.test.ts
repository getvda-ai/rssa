import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildFeed, entry, generateKey, keyFromJwk, parseFeed, verifyEntry } from "../src/index.ts";

for (const format of ["atom", "rss", "json"] as const) {
  test(`buildFeed ${format}: every entry round-trips and verifies`, async () => {
    const key = await generateKey();
    const feedUrl = `https://a.example/rssa/feed.${format}`;
    const q = entry({ title: "Q", summary: "Question?\r\nwith CRLF", content: 'Body & <tags> "quoted"', type: "question.asked", to: "group", source: "https://a.example/s", updated: "2026-10-05T09:00:00Z" });
    const r = entry({ type: "reaction", reaction: "ack", inReplyTo: q.id, updated: "2026-10-05T09:01:00Z" });
    const body = await buildFeed({ feedUrl, cardUrl: "https://a.example/card.json", hubUrl: "https://hub.example/", title: "A & B", key, format }, [q, r]);
    const p = parseFeed(body);
    assert.equal(p.format, format);
    assert.equal(p.selfUrl, feedUrl);
    assert.equal(p.cardUrl, "https://a.example/card.json");
    assert.equal(p.hubUrl, "https://hub.example/");
    assert.equal(p.entries.length, 2);
    for (const e of p.entries) {
      const v = await verifyEntry(e, feedUrl, [key.publicJwk]);
      assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
    }
  });
}

test("cross-language: JS verifies feeds the Python SDK built in all three formats", async () => {
  const py = `
import json, rssa
k = rssa.key_from_seed(bytes(range(32)))
out = {"jwk": k.public_jwk}
for f in ["atom", "rss", "json"]:
    q = rssa.entry("Q", "Caf\u00e9 \u2014 summary", "content & more", type="question.asked", to="role:ops", id="tag:x,2026:" + f, updated="2026-10-05T09:00:00Z")
    out[f] = rssa.build_feed("https://x.example/feed." + f, "X", [q], key=k, card_url="https://x.example/card.json", format=f)
print(json.dumps(out))
`;
  const out = JSON.parse(execFileSync("python", ["-c", py], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  for (const f of ["atom", "rss", "json"]) {
    const p = parseFeed(out[f]);
    assert.equal(p.entries.length, 1, f);
    const v = await verifyEntry(p.entries[0], `https://x.example/feed.${f}`, [out.jwk]);
    assert.ok(v.ok, `${f}: ${JSON.stringify(v.checks.filter((c) => !c.ok))}`);
  }
  void keyFromJwk;
});
