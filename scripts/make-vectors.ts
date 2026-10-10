// Generates test-vectors/*.json from fixed seeds. Ed25519 is deterministic, so the output
// is stable; CI regenerates and fails on any diff, and the Python SDK verifies every vector.

import { writeFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import {
  PRESETS, checkContinuity, checkEntry, canonicalize, contentHash, contentHashInput, entryPayload, hex, keyFromSeed, rotationStatement,
  signDetached, signEntry, signPolicy, thumbprint, utf8, type RssaEntry,
} from "../packages/sdk-js/src/index.ts";

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 0xff);
const out = (name: string, v: unknown) => writeFileSync(new URL(`../test-vectors/${name}`, import.meta.url), JSON.stringify(v, null, 2) + "\n");

const key = await keyFromSeed(seed(1));

// 1. Canonicalisation: input JSON text → canonical text. Negative cases must be rejected.
const canon = [
  ["key-order", `{"b":1,"a":2,"A":3,"aa":4,"_":5}`],
  ["utf16-order", `{"€":1,"😀":2,"ﬁ":3,"z":4}`],
  ["nested", `{"z":{"y":[3,1,{"b":true,"a":null}]},"a":"x"}`],
  ["escapes", `{"s":"quote\\" backslash\\\\ nl\\n tab\\t cr\\r bs\\b ff\\f ctl\\u0001 del\\u007f slash\\/ nbsp\\u00a0"}`],
  ["unicode-literal", `{"s":"caf\\u00e9 é 😀  "}`],
  ["integers", `{"max":9007199254740991,"min":-9007199254740991,"zero":0,"neg":-42}`],
  ["whitespace", `  { "a" : [ 1 , 2 ] ,\n "b" : "c" }  `],
].map(([name, input]) => ({ name, input, canonical: canonicalize(JSON.parse(input)), canonicalHex: hex(utf8(canonicalize(JSON.parse(input)))) }));
const reject = [
  ["float", `{"amount":12.5}`, "float"],
  ["float-trailing-zero", `{"amount":1.0}`, "float"],
  ["exponent", `{"n":1e3}`, "float"],
  ["unsafe-integer", `{"n":9007199254740992}`, "unsafe-integer"],
  ["duplicate-key", `{"a":1,"a":2}`, "duplicate-key"],
  ["lone-surrogate", `{"s":"\\ud800"}`, "lone-surrogate"],
  ["trailing-garbage", `{"a":1}x`, "syntax"],
].map(([name, input, error]) => ({ name, input, error }));
out("canonical.json", { description: "RFC 8785 (JCS) restricted to the RSSA signable subset. `valid`: canonical output must match byte for byte. `invalid`: the implementation must reject the input with the given error code.", valid: canon, invalid: reject });

// 2. Entry signing.
const entries = [
  { id: "urn:uuid:7c1e2d3a-0000-4000-8000-000000000001", updated: "2026-10-05T14:20:00Z", type: "exception.reported", to: "role:logistics", source: "https://erp.example.com/orders/88231", summary: "Order 88231 delayed 48h: port congestion at Rotterdam.", content: "Container MSKU1234567 held at Rotterdam.\r\nNew ETA 2026-10-07. Amount at risk: \"12.50\" EUR/unit." },
  { id: "urn:uuid:7c1e2d3a-0000-4000-8000-000000000002", updated: "2026-10-05T15:00:00Z", type: "reaction", reaction: "ack", inReplyTo: "urn:uuid:7c1e2d3a-0000-4000-8000-000000000001" },
  { id: "tag:agent.example.com,2026:brief-1", updated: "2026-10-05T16:00:00Z", summary: "  Café prices ↑ 3% 😀  ", content: "<p>HTML content &amp; entities</p>" },
];
const feedUrl = "https://agent.example.com/rssa/feed.atom";
const signed = [];
for (const e of entries) {
  const payload = await entryPayload(e, feedUrl);
  const s = await signEntry(e, feedUrl, key);
  signed.push({ entry: e, feed: feedUrl, contentHashInput: contentHashInput(e), contentHash: await contentHash(e), payloadCanonical: canonicalize(payload), sig: s.sig });
}
out("entries.json", {
  description: "Entry signing. contentHash = sha256 of contentHashInput (canonical JSON of the trimmed, LF-normalised summary and content). sig = detached compact JWS (EdDSA) over payloadCanonical. Verify every sig with publicJwk; re-sign with privateJwk and get the same sig (Ed25519 is deterministic).",
  privateJwk: key.privateJwk,
  publicJwk: key.publicJwk,
  kid: key.kid,
  thumbprintInput: canonicalize({ crv: "Ed25519", kty: "OKP", x: key.publicJwk.x }),
  vectors: signed,
});

// 3. Tampered entries that must fail verification, with the check that must fail.
const base = signed[0];
const tampered = [
  { name: "summary-changed", entry: { ...base.entry, summary: "Order 88231 on time." }, sig: base.sig, payload: base.payloadCanonical, failsCheck: "content-hash" },
  { name: "to-added", entry: { ...signed[2].entry, to: "group" }, sig: signed[2].sig, payload: signed[2].payloadCanonical, failsCheck: "bind-to" },
  { name: "copied-to-other-feed", entry: base.entry, feed: "https://evil.example/feed.atom", sig: base.sig, payload: base.payloadCanonical, failsCheck: "bind-feed" },
  { name: "updated-changed", entry: { ...base.entry, updated: "2026-10-06T14:20:00Z" }, sig: base.sig, payload: base.payloadCanonical.replace("2026-10-05T14:20:00Z", "2026-10-06T14:20:00Z"), failsCheck: "signature" },
  { name: "float-in-payload", entry: base.entry, sig: base.sig, payload: base.payloadCanonical.replace(`"id"`, `"amount":12.5,"id"`), failsCheck: "payload-float" },
  { name: "wrong-key", entry: base.entry, sig: await signDetached(utf8(base.payloadCanonical), await keyFromSeed(seed(2))), payload: base.payloadCanonical, failsCheck: "signature" },
].map((t) => ({ feed: feedUrl, ...t }));
out("entries-invalid.json", { description: "Each vector must FAIL verification against entries.json publicJwk; failsCheck names the check that fails.", vectors: tampered });

// 4. Group policy signing.
const owner = await keyFromSeed(seed(3));
const policy = await signPolicy({
  version: 12,
  group: "https://groups.example.com/supply-ops/policy.json",
  name: "Supply Ops — Brewer and Suppliers",
  owner: "https://groups.example.com/.well-known/jwks.json",
  members: [
    { feed: "https://agent.brewer.example/rssa/feed.atom", role: "coordinator" },
    { feed: "https://agent.supplier-b.example/rssa/feed.atom", role: "member" },
  ],
  preset: "standard",
  overrides: { maxDepth: 8, minInterval: "PT5M" },
  requiredModules: ["sign", "thread", "controls"],
  hub: "https://hub.example.com/g/supply-ops",
}, owner);
const { sig: _sig, ...unsignedPolicy } = policy;
out("policy.json", {
  description: "Group policy signing: sig = detached JWS over the canonical policy without its sig field.",
  ownerPublicJwk: owner.publicJwk,
  policy,
  canonicalUnsigned: canonicalize(unsignedPolicy),
});
// 5. Key rotation statements and continuity (sign.md §9). The expected results are written by hand;
// the JS implementation is asserted against them here, and the Python SDK against the file.
const [kA, kB, kC, kD] = await Promise.all([11, 12, 13, 14].map((n) => keyFromSeed(seed(n))));
const card = "https://agent.example.com/.well-known/agent-card.json";
const at = "2026-10-10T09:00:00Z";
const AB = await rotationStatement(card, kA, kB.publicJwk, at);
const BC = await rotationStatement(card, kB, kC.publicJwk, at);
const AD = await rotationStatement(card, kA, kD.publicJwk, at);
const wrongCard = await rotationStatement("https://other.example/.well-known/agent-card.json", kA, kB.publicJwk, at);
const t = { A: await thumbprint(kA.publicJwk), B: await thumbprint(kB.publicJwk), C: await thumbprint(kC.publicJwk), D: await thumbprint(kD.publicJwk) };
const pub = { A: kA.publicJwk, B: kB.publicJwk, C: kC.publicJwk, D: kD.publicJwk };
type K = keyof typeof pub;
const cases: Array<{ name: string; trusted: K[]; current: K[]; rotations: unknown[]; pins?: K[]; seen?: Partial<Record<K, K>>; continuous: K[]; unannounced: K[]; forks: K[] }> = [
  { name: "announced", trusted: ["A"], current: ["B"], rotations: [AB], continuous: ["B"], unannounced: [], forks: [] },
  { name: "chain", trusted: ["A"], current: ["C"], rotations: [BC, AB], continuous: ["C"], unannounced: [], forks: [] },
  { name: "unchanged", trusted: ["A"], current: ["A"], rotations: [], continuous: ["A"], unannounced: [], forks: [] },
  { name: "silent-change", trusted: ["A"], current: ["D"], rotations: [], continuous: [], unannounced: ["D"], forks: [] },
  { name: "fork", trusted: ["A"], current: ["B"], rotations: [AB, AD], continuous: [], unannounced: ["B"], forks: ["A"] },
  { name: "fork-remembered", trusted: ["A"], current: ["D"], rotations: [AD], seen: { A: "B" }, continuous: [], unannounced: ["D"], forks: ["A"] },
  { name: "owner-pin", trusted: ["A"], current: ["D"], rotations: [], pins: ["D"], continuous: ["D"], unannounced: [], forks: [] },
  { name: "bad-signature", trusted: ["A"], current: ["B"], rotations: [{ ...AB, sig: AD.sig }], continuous: [], unannounced: ["B"], forks: [] },
  { name: "wrong-card", trusted: ["A"], current: ["B"], rotations: [wrongCard], continuous: [], unannounced: ["B"], forks: [] },
  { name: "signer-not-trusted", trusted: ["D"], current: ["C"], rotations: [BC], continuous: [], unannounced: ["C"], forks: [] },
];
const rotationCases = [];
for (const c of cases) {
  const r = await checkContinuity({
    cardUrl: card, trusted: c.trusted.map((k) => pub[k]), current: c.current.map((k) => pub[k]), rotations: c.rotations as any,
    pins: c.pins?.map((k) => t[k]), seen: c.seen && Object.fromEntries(Object.entries(c.seen).map(([a, b]) => [t[a as K], t[b as K]])),
  });
  const want = { continuous: c.continuous.map((k) => t[k]), unannounced: c.unannounced.map((k) => t[k]), forks: c.forks.map((k) => t[k]) };
  deepStrictEqual({ continuous: r.continuous, unannounced: r.unannounced, forks: r.forks }, want, `rotation case ${c.name}`);
  rotationCases.push({
    name: c.name, trusted: c.trusted.map((k) => pub[k]), current: c.current.map((k) => pub[k]), rotations: c.rotations,
    ...(c.pins ? { pins: c.pins.map((k) => t[k]) } : {}), ...(c.seen ? { seen: Object.fromEntries(Object.entries(c.seen).map(([a, b]) => [t[a as K], t[b as K]])) } : {}),
    expect: want,
  });
}
out("rotation.json", {
  description: "Key rotation statements (sign.md §9). `statement` must be reproduced byte for byte from privateJwks (Ed25519 is deterministic); every case must give `expect`.",
  card, at,
  privateJwks: { A: kA.privateJwk, B: kB.privateJwk, C: kC.privateJwk, D: kD.privateJwk },
  thumbprints: t,
  statement: { from: "A", to: "B", signedInput: canonicalize({ type: "rssa.key-rotation", card, prev: t.A, next: t.B, at }), value: AB },
  cases: rotationCases,
});

// 6. Controls added in v0.2: heartbeats, future-dated entries and the post caps. Expected codes are hand-written.
const NOW = Date.parse("2026-10-10T12:00:00Z");
const F1 = "https://a.example/feed.atom", F2 = "https://b.example/feed.atom";
const min = (m: number) => new Date(NOW - m * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const ctrl: Array<{ name: string; preset: "open" | "standard" | "strict"; overrides?: Record<string, unknown>; entry: Partial<RssaEntry>; feed?: string; posts?: Array<[string, string]>; edit?: boolean; codes: string[] }> = [
  { name: "heartbeat-under-strict", preset: "strict", entry: { type: "agent.heartbeat", updated: min(1) }, codes: [] },
  { name: "heartbeat-as-reply", preset: "standard", entry: { type: "agent.heartbeat", updated: min(1), inReplyTo: "urn:x" }, codes: ["heartbeat-reply"] },
  { name: "future-dated", preset: "standard", entry: { type: "brief.published", summary: "s", updated: min(-6) }, codes: ["future-dated"] },
  { name: "within-skew", preset: "standard", entry: { type: "brief.published", summary: "s", updated: min(-4) }, codes: [] },
  { name: "member-cap-reached", preset: "standard", overrides: { maxPostsPerMember: 2 }, entry: { type: "brief.published", summary: "s", updated: min(0) }, posts: [[F1, min(50)], [F1, min(10)], [F2, min(5)]], codes: ["member-rate"] },
  { name: "member-cap-window-is-exclusive", preset: "standard", overrides: { maxPostsPerMember: 2 }, entry: { type: "brief.published", summary: "s", updated: min(0) }, posts: [[F1, min(60)], [F1, min(10)]], codes: [] },
  { name: "member-cap-edit", preset: "standard", overrides: { maxPostsPerMember: 2 }, entry: { type: "brief.published", summary: "s", updated: min(0) }, posts: [[F1, min(50)], [F1, min(10)]], edit: true, codes: [] },
  { name: "member-cap-reaction", preset: "standard", overrides: { maxPostsPerMember: 2 }, entry: { type: "reaction", reaction: "ack", inReplyTo: "urn:x", updated: min(0) }, posts: [[F1, min(50)], [F1, min(10)]], codes: [] },
  { name: "group-cap-reached", preset: "standard", overrides: { maxGroupPosts: 3 }, entry: { type: "brief.published", summary: "s", updated: min(0) }, posts: [[F1, min(50)], [F2, min(10)], [F2, min(5)]], codes: ["group-rate"] },
  { name: "strict-defaults-member-cap", preset: "strict", overrides: { declaredTypes: ["brief.published"] }, entry: { type: "brief.published", summary: "s", to: "group", updated: min(0) }, posts: Array.from({ length: 12 }, (_, i) => [F1, min(55 - i * 4)] as [string, string]), codes: ["member-rate"] },
];
const ctrlOut = [];
for (const c of ctrl) {
  const s = { ...PRESETS[c.preset], ...(c.overrides ?? {}) } as any;
  const e = { id: "urn:uuid:00000000-0000-4000-8000-0000000000aa", ...c.entry } as RssaEntry;
  const ledger = (c.posts ?? []).map(([f, u]) => [f, Date.parse(u)] as const);
  const v = checkEntry(e, c.feed ?? F1, s, {
    depthOf: () => undefined, rootOf: () => undefined, lastPost: () => undefined,
    postsIn: (f, a, b) => ledger.filter(([lf, lt]) => (f === undefined || lf === f) && lt > a && lt <= b).length,
    isEdit: () => !!c.edit, now: () => NOW,
  });
  deepStrictEqual(v.map((x) => x.code), c.codes, `controls case ${c.name}`);
  ctrlOut.push({ name: c.name, preset: c.preset, overrides: c.overrides ?? {}, feed: c.feed ?? F1, entry: e, posts: c.posts ?? [], edit: !!c.edit, codes: c.codes });
}
out("controls.json", {
  description: "checkEntry for the v0.2 controls. `posts` are accepted [feed, updated] pairs (the window is (updated - rateWindow, updated]); `edit` says the id was already accepted; `now` is the reader's clock. Each case must give exactly `codes`.",
  now: new Date(NOW).toISOString(), cases: ctrlOut,
});

console.log(`wrote test-vectors (kid ${key.kid}, thumbprint ok: ${(await thumbprint(key.publicJwk)) === key.kid})`);
