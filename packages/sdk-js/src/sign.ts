// The sign module: entries are signed as a small JSON payload, never as XML.

import { CanonicalError, canonicalize, strictParse, utf8 } from "./canonical.ts";
import type { RssaEntry } from "./feed.ts";
import { hex, sha256, signDetached, verifyDetached, type PublicJwk, type RssaKey } from "./keys.ts";

/** Payload fields copied from the entry, in addition to id, updated, feed and contentHash. */
export const BOUND_FIELDS = ["type", "to", "source", "inReplyTo", "reaction"] as const;

/** Normalises text before hashing so that XML/JSON round-trips cannot change it. */
export function normaliseText(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

/** The exact bytes covered by contentHash: canonical JSON of {summary, content}. */
export function contentHashInput(e: Pick<RssaEntry, "summary" | "content">): string {
  const o: Record<string, string> = {};
  if (e.summary !== undefined) o.summary = normaliseText(e.summary);
  if (e.content !== undefined) o.content = normaliseText(e.content);
  return canonicalize(o);
}

export async function contentHash(e: Pick<RssaEntry, "summary" | "content">): Promise<string> {
  return "sha256:" + hex(await sha256(utf8(contentHashInput(e))));
}

/** Builds the signable payload for an entry published in `feedUrl`. */
export async function entryPayload(e: RssaEntry, feedUrl: string): Promise<Record<string, string>> {
  const p: Record<string, string> = { id: e.id, updated: e.updated, feed: feedUrl, contentHash: await contentHash(e) };
  for (const k of BOUND_FIELDS) if (e[k] !== undefined) p[k] = e[k]!;
  return p;
}

/** Returns a copy of the entry carrying rssa:payload and rssa:sig. */
export async function signEntry(e: RssaEntry, feedUrl: string, key: RssaKey): Promise<RssaEntry> {
  if (e.contentType === "xhtml") throw new Error(`entry ${e.id}: xhtml content cannot be signed; use type "text" or "html"`);
  const payload = canonicalize(await entryPayload(e, feedUrl));
  return { ...e, payload, sig: await signDetached(utf8(payload), key) };
}

export interface Check {
  ok: boolean;
  code: string;
  message: string;
  /** Extra detail for humans: canonical bytes, first differing offset, a fix. */
  explain?: string;
}

export interface EntryVerification {
  ok: boolean;
  checks: Check[];
  payload?: Record<string, unknown>;
}

/** Where two strings first differ, with context — the validator's "explain" output. */
export function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return "identical";
  const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 20));
  return `first difference at character ${i}:\n  expected …${ctx(a)}…\n  found    …${ctx(b)}…`;
}

const sameInstant = (a: unknown, b: string) => typeof a === "string" && Date.parse(a) === Date.parse(b);

/**
 * Verifies a signed entry: payload is canonical-safe, bound to this entry and feed,
 * content unchanged, and the signature checks against one of `keys`.
 * `feedUrl` is the feed the entry is attributed to (its own feed, or atom:source in a merged feed).
 */
export async function verifyEntry(e: RssaEntry, feedUrl: string, keys: PublicJwk[]): Promise<EntryVerification> {
  const checks: Check[] = [];
  const add = (ok: boolean, code: string, message: string, explain?: string) => { checks.push({ ok, code, message, ...(explain ? { explain } : {}) }); return ok; };
  if (!e.payload || !e.sig) {
    add(false, "unsigned", `entry ${e.id} has no ${!e.payload ? "<rssa:payload>" : "<rssa:sig>"}`, "Sign entries with the SDK: signEntry(entry, feedUrl, key) / rssa.sign_entry(...)");
    return { ok: false, checks };
  }
  let payload: any;
  try {
    payload = strictParse(e.payload);
  } catch (err) {
    const code = err instanceof CanonicalError ? err.code : "syntax";
    add(false, `payload-${code}`, `payload of ${e.id} is not signable JSON: ${(err as Error).message}`,
      "Signed payloads allow only strings, booleans and integers within ±2^53. Send amounts as strings (\"12.50\").");
    return { ok: false, checks };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    add(false, "payload-shape", "payload must be a JSON object");
    return { ok: false, checks };
  }
  const canonical = canonicalize(payload);
  if (canonical !== e.payload) {
    add(true, "payload-not-canonical", "payload text is not in canonical form (allowed; it is canonicalised before verification)", firstDifference(canonical, e.payload));
  }
  add(payload.id === e.id, "bind-id", payload.id === e.id ? "payload id matches entry id" : `payload id ${JSON.stringify(payload.id)} ≠ entry id ${JSON.stringify(e.id)}`);
  add(sameInstant(payload.updated, e.updated), "bind-updated", sameInstant(payload.updated, e.updated) ? "payload updated matches entry" : `payload updated ${payload.updated} ≠ entry updated ${e.updated}`);
  add(payload.feed === feedUrl, "bind-feed", payload.feed === feedUrl ? "payload is bound to this feed" : `payload feed ${JSON.stringify(payload.feed)} ≠ ${JSON.stringify(feedUrl)} — copied from another feed, or the feed URL changed`);
  for (const k of BOUND_FIELDS) {
    if (payload[k] !== e[k]) add(false, `bind-${k}`, `payload ${k} ${JSON.stringify(payload[k])} ≠ entry ${k} ${JSON.stringify(e[k])}`);
  }
  const expected = await contentHash(e);
  add(payload.contentHash === expected, "content-hash",
    payload.contentHash === expected ? "summary and content unchanged" : "summary or content changed after signing",
    payload.contentHash === expected ? undefined : `hash input recomputed by the verifier (canonical JSON of the normalised summary and content):\n  ${contentHashInput(e)}\n  → ${expected}\n  payload says ${payload.contentHash}`);
  const r = await verifyDetached(e.sig, utf8(canonical), keys);
  add(r.ok, "signature", r.ok ? `signature valid (kid ${r.kid})` : r.error!,
    r.ok ? undefined : `canonical bytes the verifier checked (${utf8(canonical).length} bytes):\n  ${canonical}\nIf your implementation signed different bytes, compare them with test-vectors/canonical.json.`);
  return { ok: checks.every((c) => c.ok), checks, payload };
}
