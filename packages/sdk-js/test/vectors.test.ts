import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CanonicalError, canonicalize, keyFromJwk, signEntry, strictParse, thumbprint, verifyDetached, verifyEntry, verifyPolicy, utf8,
} from "../src/index.ts";

const load = (n: string) => JSON.parse(readFileSync(new URL(`../../../test-vectors/${n}`, import.meta.url), "utf8"));

test("canonical: valid vectors match byte for byte", () => {
  for (const v of load("canonical.json").valid) assert.equal(canonicalize(strictParse(v.input)), v.canonical, v.name);
});

test("canonical: invalid vectors are rejected with the right code", () => {
  for (const v of load("canonical.json").invalid) {
    assert.throws(() => strictParse(v.input), (e: unknown) => e instanceof CanonicalError && e.code === v.error, v.name);
  }
});

test("canonical: values outside the subset are rejected", () => {
  assert.throws(() => canonicalize({ a: 1.5 }), /not an integer/);
  assert.throws(() => canonicalize({ a: 2 ** 60 }), /outside/);
  assert.throws(() => canonicalize({ a: undefined }), /cannot be signed/);
});

test("entries: re-signing reproduces every signature, and every vector verifies", async () => {
  const f = load("entries.json");
  const key = await keyFromJwk(f.privateJwk);
  assert.equal(key.kid, f.kid);
  assert.equal(await thumbprint(f.publicJwk), f.kid);
  for (const v of f.vectors) {
    const s = await signEntry(v.entry, v.feed, key);
    assert.equal(s.payload, v.payloadCanonical);
    assert.equal(s.sig, v.sig);
    const r = await verifyEntry({ ...v.entry, payload: v.payloadCanonical, sig: v.sig }, v.feed, [f.publicJwk]);
    assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok)));
  }
});

test("entries: every tampered vector fails, on the named check", async () => {
  const pub = load("entries.json").publicJwk;
  for (const v of load("entries-invalid.json").vectors) {
    const r = await verifyEntry({ ...v.entry, payload: v.payload, sig: v.sig }, v.feed, [pub]);
    assert.equal(r.ok, false, v.name);
    assert.ok(r.checks.some((c) => !c.ok && c.code === v.failsCheck), `${v.name}: expected ${v.failsCheck} to fail, got ${JSON.stringify(r.checks.filter((c) => !c.ok).map((c) => c.code))}`);
  }
});

test("policy: signature verifies, and fails after any change", async () => {
  const f = load("policy.json");
  const fetcher = async () => new Response(JSON.stringify({ keys: [f.ownerPublicJwk] }));
  assert.ok((await verifyPolicy(f.policy, fetcher as any)).ok);
  assert.equal((await verifyPolicy({ ...f.policy, version: 13 }, fetcher as any)).ok, false);
  const { sig, ...rest } = f.policy;
  assert.equal(canonicalize(rest), f.canonicalUnsigned);
  assert.ok((await verifyDetached(sig, utf8(f.canonicalUnsigned), [f.ownerPublicJwk])).ok);
});
