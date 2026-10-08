// Generates test-vectors/*.json from fixed seeds. Ed25519 is deterministic, so the output
// is stable; CI regenerates and fails on any diff, and the Python SDK verifies every vector.

import { writeFileSync } from "node:fs";
import {
  canonicalize, contentHash, contentHashInput, entryPayload, hex, keyFromSeed, signDetached, signEntry, signPolicy, thumbprint, utf8,
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
console.log(`wrote test-vectors (kid ${key.kid}, thumbprint ok: ${(await thumbprint(key.publicJwk)) === key.kid})`);
