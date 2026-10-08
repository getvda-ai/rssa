"""Ed25519 keys as JWK, and detached compact JWS (RFC 7515 Appendix F)."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib.parse import unquote

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

from .canonical import canonicalize

EXT_PREFIX = "https://rssa.getvda.ai/ext/"


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def thumbprint(jwk: dict) -> str:
    """RFC 7638 JWK thumbprint — the default key id."""
    return b64url(hashlib.sha256(canonicalize({"crv": "Ed25519", "kty": "OKP", "x": jwk["x"]}).encode()).digest())


@dataclass
class Key:
    kid: str
    private_jwk: dict
    public_jwk: dict

    def public_jwks(self) -> dict:
        """The value to put in the Agent Card's RSSA params as "keys"."""
        return {"keys": [self.public_jwk]}

    def _private(self) -> Ed25519PrivateKey:
        return Ed25519PrivateKey.from_private_bytes(b64url_decode(self.private_jwk["d"]))


def _from_private(pk: Ed25519PrivateKey) -> Key:
    d = pk.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    x = pk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return key_from_jwk({"kty": "OKP", "crv": "Ed25519", "x": b64url(x), "d": b64url(d)})


def generate_key() -> Key:
    return _from_private(Ed25519PrivateKey.generate())


def key_from_seed(seed: bytes) -> Key:
    """Deterministic key from a 32-byte seed. For test vectors and demos only."""
    return _from_private(Ed25519PrivateKey.from_private_bytes(seed))


def key_from_jwk(jwk: dict | str) -> Key:
    """Accepts a private JWK dict or its JSON text (e.g. from an environment variable or secret)."""
    j = json.loads(jwk) if isinstance(jwk, str) else jwk
    if j.get("kty") != "OKP" or j.get("crv") != "Ed25519" or "x" not in j or "d" not in j:
        raise ValueError("expected an Ed25519 private JWK with kty, crv, x and d")
    kid = j.get("kid") or thumbprint(j)
    return Key(
        kid=kid,
        private_jwk={"kty": "OKP", "crv": "Ed25519", "x": j["x"], "d": j["d"], "kid": kid},
        public_jwk={"kty": "OKP", "crv": "Ed25519", "x": j["x"], "kid": kid},
    )


def load_key(source: str | None = None) -> Key:
    """Loads a private JWK from a file path, raw JSON text, or the RSSA_KEY environment variable."""
    source = source or os.environ.get("RSSA_KEY")
    if not source:
        raise ValueError("no key: pass a path or JWK JSON, or set RSSA_KEY")
    if source.lstrip().startswith("{"):
        return key_from_jwk(source)
    with open(source, encoding="utf-8") as f:
        return key_from_jwk(f.read())


def sign_detached(payload: bytes, key: Key) -> str:
    """Detached compact JWS over payload: '<header>..<signature>'."""
    header = b64url(canonicalize({"alg": "EdDSA", "kid": key.kid}).encode())
    sig = key._private().sign(f"{header}.{b64url(payload)}".encode("ascii"))
    return f"{header}..{b64url(sig)}"


def verify_detached(jws: str, payload: bytes, keys: list[dict]) -> tuple[bool, Optional[str]]:
    """Returns (ok, error). Keys are matched by kid when the JWS header has one."""
    parts = jws.split(".")
    if len(parts) != 3 or parts[1] != "":
        return False, "signature is not a detached compact JWS (expected header..signature)"
    try:
        header = json.loads(b64url_decode(parts[0]))
    except Exception:
        return False, "JWS header is not base64url JSON"
    if header.get("alg") != "EdDSA":
        return False, f"JWS alg must be EdDSA, got {header.get('alg')}"
    if header.get("b64") is False:
        return False, "unencoded (b64:false) JWS payloads are not used in RSSA"
    with_kids = [(k, k.get("kid") or thumbprint(k)) for k in keys if k.get("kty") == "OKP" and k.get("crv") == "Ed25519"]
    candidates = [c for c in with_kids if c[1] == header["kid"]] if header.get("kid") else with_kids
    if not candidates:
        return False, f"no published key has kid {header.get('kid')} (published: {', '.join(k for _, k in with_kids) or 'none'})"
    signing_input = f"{parts[0]}.{b64url(payload)}".encode("ascii")
    try:
        sig = b64url_decode(parts[2])
    except Exception:
        return False, "JWS signature is not base64url"
    for k, _ in candidates:
        try:
            Ed25519PublicKey.from_public_bytes(b64url_decode(k["x"])).verify(sig, signing_input)
            return True, None
        except (InvalidSignature, ValueError):
            continue
    return False, "signature does not verify against the published key"


Fetch = Callable[[str], tuple[int, str]]


def http_get(url: str, accept: str = "application/json", user_agent: str = "rssa-sdk-py/0.1 (+https://rssa.getvda.ai)") -> tuple[int, str]:
    """Default fetcher: (status, text). Never raises for HTTP errors."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": user_agent})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, ""


def get_json(url: str, fetch: Fetch = http_get) -> Any:
    status, text = fetch(url)
    if status != 200:
        raise ValueError(f"GET {url} returned {status}")
    return json.loads(text)


def resolve_keys(ref: Any, fetch: Fetch = http_get, depth: int = 0) -> list[dict]:
    """Resolves a key reference: inline JWKS, https URL (JWKS or Agent Card), or did:web."""
    if depth > 2:
        raise ValueError("key reference chain too deep")
    ed = lambda ks: [k for k in ks if isinstance(k, dict) and k.get("kty") == "OKP" and k.get("crv") == "Ed25519" and "x" in k]
    if isinstance(ref, dict) and isinstance(ref.get("keys"), list):
        return ed(ref["keys"])
    if not isinstance(ref, str):
        raise ValueError("keys must be an inline JWKS, an https URL or a did:web")
    if ref.startswith("did:web:"):
        host, *path = [unquote(p) for p in ref[8:].split(":")]
        url = f"https://{host}/{'/'.join(path)}/did.json" if path else f"https://{host}/.well-known/did.json"
        doc = get_json(url, fetch)
        out = []
        for vm in doc.get("verificationMethod", []):
            jwk = vm.get("publicKeyJwk")
            if jwk and ed([jwk]):
                out.append({**jwk, "kid": jwk.get("kid") or str(vm.get("id", "")).split("#")[-1]})
        return out
    if ref.startswith("https://") or ref.startswith("http://localhost") or ref.startswith("http://127.0.0.1"):
        doc = get_json(ref, fetch)
        if isinstance(doc.get("keys"), list):
            return ed(doc["keys"])
        for e in doc.get("capabilities", {}).get("extensions", []):
            if str(e.get("uri", "")).startswith(EXT_PREFIX) and e.get("params", {}).get("keys"):
                return resolve_keys(e["params"]["keys"], fetch, depth + 1)
        raise ValueError(f"{ref} is neither a JWKS nor an Agent Card with RSSA keys")
    raise ValueError(f"unsupported key reference {ref}")
