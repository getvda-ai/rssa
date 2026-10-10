// Key continuity (sign.md §9): a new key is announced by a rotation statement signed by the key it
// replaces, published in the card's params.rotations. A verifier that remembers a member's keys can
// then tell a planned rotation from a silent key swap.

import { canonicalize, utf8 } from "./canonical.ts";
import { signDetached, thumbprint, verifyDetached, type PublicJwk, type RssaKey } from "./keys.ts";

export const ROTATION_TYPE = "rssa.key-rotation";
/** Longest chain of statements a verifier follows (bounds the work a hostile card can cause). */
export const MAX_CHAIN = 10;

export interface RotationStatement {
  /** RFC 7638 thumbprint of the key being replaced (the signer). */
  prev: string;
  /** The new public key. */
  next: PublicJwk;
  /** When the rotation was made (RFC 3339). */
  at: string;
  /** Detached JWS by the `prev` key over JCS({type, card, prev, next: thumbprint(next), at}). */
  sig: string;
}

const publicOnly = (k: PublicJwk): PublicJwk => ({ kty: "OKP", crv: "Ed25519", x: k.x, ...(k.kid ? { kid: k.kid } : {}) });

async function signedBytes(cardUrl: string, prev: string, next: PublicJwk, at: string) {
  return utf8(canonicalize({ type: ROTATION_TYPE, card: cardUrl, prev, next: await thumbprint(next), at }));
}

/** Makes the statement announcing `next` as the successor of `old`, for the card at `cardUrl`. */
export async function rotationStatement(cardUrl: string, old: RssaKey, next: PublicJwk, at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")): Promise<RotationStatement> {
  const prev = await thumbprint(old.publicJwk);
  const n = publicOnly(next);
  // The JWS kid is the thumbprint, so the statement verifies whatever kid the card gives the key.
  return { prev, next: n, at, sig: await signDetached(await signedBytes(cardUrl, prev, n, at), { ...old, kid: prev }) };
}

export interface Continuity {
  /** Thumbprints in the new key set that were already trusted, announced by a valid chain, or pinned. */
  continuous: string[];
  /** Thumbprints in the new key set with no statement or pin: a silent key change. */
  unannounced: string[];
  /** Keys that signed two different successors (equivocation). Their successors are not trusted. */
  forks: string[];
  /** Every trusted key after this check (old trusted plus announced plus pinned), as public JWKs. */
  trusted: PublicJwk[];
  /** Valid statements found (prev → next thumbprints), forked or not. */
  edges: Array<{ prev: string; next: string }>;
  problems: string[];
}

/**
 * Checks a card's current key set against the keys a verifier already trusts for it.
 * `pins` are thumbprints the group owner approved (policy members[].keys): accepted as if announced.
 * `seen` maps a key's thumbprint to the successor it was seen to announce earlier; a different
 * successor now is a fork, even if the old statement has since been removed from the card.
 */
export async function checkContinuity(o: {
  cardUrl: string;
  trusted: PublicJwk[];
  current: PublicJwk[];
  rotations?: RotationStatement[];
  pins?: string[];
  seen?: Record<string, string>;
}): Promise<Continuity> {
  const problems: string[] = [];
  const trusted = new Map<string, PublicJwk>();
  for (const k of o.trusted) trusted.set(await thumbprint(k), publicOnly(k));
  const pins = new Set(o.pins ?? []);
  for (const k of o.current) {
    const t = await thumbprint(k);
    if (pins.has(t)) trusted.set(t, publicOnly(k));
  }
  // Every key a statement could be signed by: trusted keys and the keys statements announce.
  const statements = (Array.isArray(o.rotations) ? o.rotations : []).slice(0, 50)
    .filter((s) => s && typeof s === "object" && typeof s.prev === "string" && typeof s.next === "object" && typeof s.next?.x === "string" && typeof s.sig === "string" && typeof s.at === "string");
  const jwks = new Map(trusted);
  for (const s of statements) jwks.set(await thumbprint(s.next), publicOnly(s.next));
  // Valid edges prev → next: signed by the prev key.
  const edges = new Map<string, Map<string, PublicJwk>>();
  for (const s of statements) {
    const signer = jwks.get(s.prev);
    if (!signer) continue;
    const next = await thumbprint(s.next);
    const r = await verifyDetached(s.sig, await signedBytes(o.cardUrl, s.prev, publicOnly(s.next), s.at), [{ ...signer, kid: s.prev }]);
    if (!r.ok) { problems.push(`rotation ${s.prev} → ${next}: ${r.error}`); continue; }
    const m = edges.get(s.prev) ?? new Map<string, PublicJwk>();
    m.set(next, publicOnly(s.next));
    edges.set(s.prev, m);
  }
  // A key that announced two different successors (now, or earlier as remembered in `seen`) is forked.
  const forks: string[] = [];
  for (const [prev, m] of edges) {
    const succ = new Set(m.keys());
    if (o.seen?.[prev]) succ.add(o.seen[prev]);
    if (succ.size > 1) { forks.push(prev); problems.push(`key ${prev} announced more than one successor (${[...succ].join(", ")}): trusting none of them`); }
  }
  // Trust follows unforked edges from already-trusted keys, at most MAX_CHAIN steps.
  let frontier = [...trusted.keys()];
  for (let step = 0; step < MAX_CHAIN && frontier.length; step++) {
    const nextFrontier: string[] = [];
    for (const prev of frontier) {
      if (forks.includes(prev)) continue;
      for (const [t, jwk] of edges.get(prev) ?? []) if (!trusted.has(t)) { trusted.set(t, jwk); nextFrontier.push(t); }
    }
    frontier = nextFrontier;
  }
  const continuous: string[] = [], unannounced: string[] = [];
  for (const k of o.current) {
    const t = await thumbprint(k);
    (trusted.has(t) ? continuous : unannounced).push(t);
  }
  const list = [...edges].flatMap(([prev, m]) => [...m.keys()].map((next) => ({ prev, next })));
  return { continuous, unannounced, forks, trusted: [...trusted.values()], edges: list, problems };
}
