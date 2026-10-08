// Ed25519 keys as JWK, signing and detached JWS (RFC 7515 Appendix F).
// Uses WebCrypto only, so the same code runs in Node 20+, Deno, Bun and Cloudflare Workers.

import { canonicalize, utf8 } from "./canonical.ts";

export interface PublicJwk { kty: "OKP"; crv: "Ed25519"; x: string; kid?: string; [k: string]: unknown }
export interface PrivateJwk extends PublicJwk { d: string }
export interface Jwks { keys: PublicJwk[] }

export interface RssaKey {
  kid: string;
  privateJwk: PrivateJwk;
  publicJwk: PublicJwk;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

export const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** RFC 7638 JWK thumbprint — the default key id. */
export async function thumbprint(jwk: { x: string }): Promise<string> {
  return b64url(await sha256(utf8(canonicalize({ crv: "Ed25519", kty: "OKP", x: jwk.x }))));
}

export async function generateKey(): Promise<RssaKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as any;
  return keyFromJwk({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d });
}

/** Accepts a private JWK object or its JSON text (e.g. from an environment variable). */
export async function keyFromJwk(input: PrivateJwk | string): Promise<RssaKey> {
  const j = typeof input === "string" ? JSON.parse(input) : input;
  if (j.kty !== "OKP" || j.crv !== "Ed25519" || !j.x || !j.d) throw new Error("expected an Ed25519 private JWK with kty, crv, x and d");
  const kid = j.kid ?? (await thumbprint(j));
  return {
    kid,
    privateJwk: { kty: "OKP", crv: "Ed25519", x: j.x, d: j.d, kid },
    publicJwk: { kty: "OKP", crv: "Ed25519", x: j.x, kid },
  };
}

/** Deterministic key from a 32-byte seed. For test vectors and demos only. */
export async function keyFromSeed(seed: Uint8Array): Promise<RssaKey> {
  // PKCS#8 wrapper for an Ed25519 seed (RFC 8410).
  const prefix = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(prefix);
  pkcs8.set(seed, 16);
  const k = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" } as any, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", k)) as any;
  return keyFromJwk({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d });
}

async function importPrivate(jwk: PrivateJwk) {
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, { name: "Ed25519" } as any, false, ["sign"]);
}
async function importPublic(jwk: PublicJwk) {
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" } as any, false, ["verify"]);
}

/** Detached compact JWS over `payloadBytes`: "<header>..<signature>". */
export async function signDetached(payloadBytes: Uint8Array, key: RssaKey): Promise<string> {
  const header = b64url(utf8(canonicalize({ alg: "EdDSA", kid: key.kid })));
  const input = utf8(`${header}.${b64url(payloadBytes)}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" } as any, await importPrivate(key.privateJwk), input));
  return `${header}..${b64url(sig)}`;
}

export interface JwsResult { ok: boolean; kid?: string; error?: string }

/** Verifies a detached JWS against candidate public keys (matched by kid when the header has one). */
export async function verifyDetached(jws: string, payloadBytes: Uint8Array, keys: PublicJwk[]): Promise<JwsResult> {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts[1] !== "") return { ok: false, error: "signature is not a detached compact JWS (expected header..signature)" };
  let header: any;
  try { header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))); } catch { return { ok: false, error: "JWS header is not base64url JSON" }; }
  if (header.alg !== "EdDSA") return { ok: false, error: `JWS alg must be EdDSA, got ${header.alg}` };
  if (header.b64 === false) return { ok: false, error: "unencoded (b64:false) JWS payloads are not used in RSSA" };
  const withKids = await Promise.all(keys.map(async (k) => ({ k, kid: k.kid ?? (await thumbprint(k)) })));
  const candidates = header.kid ? withKids.filter((c) => c.kid === header.kid) : withKids;
  if (candidates.length === 0) return { ok: false, kid: header.kid, error: `no published key has kid ${header.kid} (published: ${withKids.map((c) => c.kid).join(", ") || "none"})` };
  const input = utf8(`${parts[0]}.${b64url(payloadBytes)}`);
  let sig: Uint8Array;
  try { sig = b64urlDecode(parts[2]); } catch { return { ok: false, error: "JWS signature is not base64url" }; }
  for (const c of candidates) {
    if (c.k.kty !== "OKP" || c.k.crv !== "Ed25519") continue;
    if (await crypto.subtle.verify({ name: "Ed25519" } as any, await importPublic(c.k), sig as unknown as BufferSource, input)) return { ok: true, kid: c.kid };
  }
  return { ok: false, kid: header.kid, error: "signature does not verify against the published key" };
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Resolves a key reference to public keys. A reference is one of:
 *  - an inline JWKS object {"keys":[...]} (simplest; lives in the Agent Card)
 *  - an https URL to a JWKS document, or to an Agent Card whose RSSA extension has keys
 *  - did:web:<host>[:path] (fetches the DID document)
 */
export async function resolveKeys(ref: unknown, fetcher: Fetcher = fetch, depth = 0): Promise<PublicJwk[]> {
  if (depth > 2) throw new Error("key reference chain too deep");
  if (ref && typeof ref === "object" && Array.isArray((ref as Jwks).keys)) return (ref as Jwks).keys.filter(isEd25519);
  if (typeof ref !== "string") throw new Error("keys must be an inline JWKS, an https URL or a did:web");
  if (ref.startsWith("did:web:")) {
    const [host, ...path] = ref.slice(8).split(":").map(decodeURIComponent);
    const url = path.length ? `https://${host}/${path.join("/")}/did.json` : `https://${host}/.well-known/did.json`;
    const doc = await getJson(url, fetcher);
    const vms: any[] = doc.verificationMethod ?? [];
    return vms
      .filter((vm) => vm.publicKeyJwk && isEd25519(vm.publicKeyJwk))
      .map((vm) => ({ ...vm.publicKeyJwk, kid: vm.publicKeyJwk.kid ?? String(vm.id).split("#").pop() }));
  }
  if (ref.startsWith("https://") || ref.startsWith("http://localhost") || ref.startsWith("http://127.0.0.1")) {
    const doc = await getJson(ref, fetcher);
    if (Array.isArray(doc.keys)) return doc.keys.filter(isEd25519);
    const ext = (doc.capabilities?.extensions ?? []).find((e: any) => typeof e?.uri === "string" && e.uri.startsWith("https://rssa.getvda.ai/ext/"));
    if (ext?.params?.keys) return resolveKeys(ext.params.keys, fetcher, depth + 1);
    throw new Error(`${ref} is neither a JWKS nor an Agent Card with RSSA keys`);
  }
  throw new Error(`unsupported key reference ${ref}`);
}

function isEd25519(k: any): k is PublicJwk {
  return k && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string";
}

export async function getJson(url: string, fetcher: Fetcher = fetch): Promise<any> {
  const r = await fetcher(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${url} returned ${r.status}`);
  return r.json();
}
