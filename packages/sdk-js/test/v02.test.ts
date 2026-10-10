// The validator's v0.2 checks: params.cadence, params.rotations, and the new policy settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyFromSeed, rotationStatement, signPolicy, thumbprint, validateCard, validatePolicyText, withRssa } from "../src/index.ts";

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + n) & 0xff);
const CARD = "https://v.example/.well-known/agent-card.json";
const codes = (f: Array<{ code: string; level: string }>, code: string) => f.filter((x) => x.code === code).map((x) => x.level);

test("card: cadence is checked, and rotation statements must verify and must not fork", async () => {
  const [a, b, c] = await Promise.all([1, 2, 3].map((n) => keyFromSeed(seed(n))));
  const card = (params: Record<string, unknown>) => withRssa({ name: "v" }, { feed: "https://v.example/feed.atom", keys: { keys: [b.publicJwk] }, ...params } as any);
  const run = (params: Record<string, unknown>) => validateCard(card(params), CARD, { deep: false });
  assert.deepEqual(codes(await run({}), "card-cadence"), ["info"], "no cadence: info, not a failure");
  assert.deepEqual(codes(await run({ cadence: "PT1H" }), "card-cadence"), ["pass"]);
  assert.deepEqual(codes(await run({ cadence: "PT1M" }), "card-cadence"), ["warn"], "finer than hubs poll");
  assert.deepEqual(codes(await run({ cadence: "hourly" }), "card-cadence"), ["fail"]);
  const ab = await rotationStatement(CARD, a, b.publicJwk);
  assert.deepEqual(codes(await run({ keys: { keys: [b.publicJwk] }, rotations: [ab] }), "card-rotations"), ["info"], "old key gone: unverifiable here, not failed");
  const both = { keys: { keys: [a.publicJwk, b.publicJwk] } };
  assert.deepEqual(codes(await run({ ...both, rotations: [ab] }), "card-rotations"), ["pass"]);
  assert.deepEqual(codes(await run({ ...both, rotations: [{ ...ab, at: "2027-01-01T00:00:00Z" }] }), "card-rotations"), ["fail"], "a tampered statement fails");
  const ac = await rotationStatement(CARD, a, c.publicJwk);
  assert.ok(codes(await run({ ...both, rotations: [ab, ac] }), "card-rotations").includes("fail"), "two successors of one key fail");
  assert.deepEqual(codes(await run({ rotations: [{ prev: "x" }] }), "card-rotations"), ["fail"]);
});

test("policy: new settings are type-checked and owner pins must be thumbprints", async () => {
  const owner = await keyFromSeed(seed(9));
  const fetcher = async () => new Response(JSON.stringify({ keys: [owner.publicJwk] }));
  const base = { version: 1, group: "https://v.example/policy.json", owner: "https://v.example/owner.json", hub: "https://hub.v.example/", members: [{ feed: "https://v.example/feed.atom" }] };
  const run = async (patch: Record<string, unknown>) => validatePolicyText(JSON.stringify(await signPolicy({ ...base, ...patch } as any, owner)), base.group, { fetcher, deep: false });
  const fails = async (patch: Record<string, unknown>) => (await run(patch)).filter((f) => f.level === "fail").map((f) => f.code);
  assert.deepEqual(await fails({ overrides: { maxPostsPerMember: 10, maxGroupPosts: 50, rateWindow: "PT1H", keyContinuity: "hold", maxCadence: "P1D" } }), []);
  assert.deepEqual(await fails({ overrides: { maxPostsPerMember: -1 } }), ["policy-override"]);
  assert.deepEqual(await fails({ overrides: { rateWindow: "1h" } }), ["policy-override"]);
  assert.deepEqual(await fails({ overrides: { keyContinuity: "block" } }), ["policy-override"]);
  assert.deepEqual(await fails({ members: [{ feed: base.members[0].feed, keys: [await thumbprint(owner.publicJwk)] }] }), []);
  assert.deepEqual(await fails({ members: [{ feed: base.members[0].feed, keys: ["not-a-thumbprint"] }] }), ["policy-member"]);
  const info = (await run({ overrides: { maxPostsPerMember: 100 } })).find((f) => f.code === "policy-override" && f.level === "info");
  assert.match(info!.message, /maxPostsPerMember: 0 → 100 \(stricter\)/, "a cap where there was none is stricter");
});
