// The hub-wide directory under concurrent writers (KV has no transactions and reads can be stale).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Directory, memoryStore } from "../src/store.ts";

test("parallel group registrations are all kept (2026-10-19: 11 of 16 were lost)", async () => {
  const d = new Directory(memoryStore());
  const ids = Array.from({ length: 16 }, (_, i) => `00000000000${i.toString(16)}`.slice(-12));
  await Promise.all(ids.map((id) => d.addGroup(id)));
  assert.deepEqual((await d.groupIds()).sort(), [...ids].sort());
});

test("parallel reindexing of one URL by many groups keeps every group; removal drops only its own", async () => {
  const d = new Directory(memoryStore());
  const url = "https://a.example/feed.atom";
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
  await Promise.all(ids.map((id) => d.reindex(id, [], [url])));
  assert.deepEqual((await d.groupsFor(url)).sort(), ids);
  await d.reindex("bbbbbbbbbbbb", [url], []);
  assert.deepEqual((await d.groupsFor(url)).sort(), ["aaaaaaaaaaaa", "cccccccccccc", "dddddddddddd"]);
});

test("arrays written by earlier hubs are still read, and cleaned when a group drops the URL", async () => {
  const s = memoryStore();
  await s.put("groups", JSON.stringify(["111111111111"]));
  await s.put("member:https://a.example/feed.atom", JSON.stringify(["111111111111", "222222222222"]));
  const d = new Directory(s);
  await d.addGroup("333333333333");
  assert.deepEqual((await d.groupIds()).sort(), ["111111111111", "333333333333"]);
  await d.reindex("333333333333", [], ["https://a.example/feed.atom"]);
  assert.deepEqual((await d.groupsFor("https://a.example/feed.atom")).sort(), ["111111111111", "222222222222", "333333333333"]);
  await d.reindex("111111111111", ["https://a.example/feed.atom"], []);
  assert.deepEqual((await d.groupsFor("https://a.example/feed.atom")).sort(), ["222222222222", "333333333333"]);
  assert.deepEqual(JSON.parse((await s.get("member:https://a.example/feed.atom"))!), ["222222222222"]);
});

test("hub 0.4.1: a group whose index predates per-key entries rewrites all of them once (lost entries come back)", async () => {
  const { Hub } = await import("../src/hub.ts");
  const { POLICY, buildGroup, feedUrl } = await import("../../scripts/synthetic.ts");
  const g = await buildGroup(2, 1);
  const store = memoryStore();
  const hub = new Hub({ store, fetch: g.web.fetcher, adminToken: "x", baseUrl: "https://hub.test" });
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  // Simulate a pre-0.4.1 group: no indexV2 flag, and one index entry lost to a concurrent writer.
  const metaKey = `r:${id}:meta:`;
  const meta = JSON.parse((await store.get(metaKey))!);
  delete meta.indexV2;
  await store.put(metaKey, JSON.stringify(meta));
  for (const k of await store.list!("mi:")) if ((await hub.dir.groupsFor(feedUrl(0))).includes(id) && k.endsWith(id)) await store.delete(k);
  assert.ok(!(await hub.dir.groupsFor(feedUrl(0))).includes(id), "the entry is gone");
  const fresh = new Hub({ store, fetch: g.web.fetcher, adminToken: "x", baseUrl: "https://hub.test" });
  await fresh.refresh(id);
  assert.ok((await fresh.dir.groupsFor(feedUrl(0))).includes(id), "rewritten on the next refresh");
});
