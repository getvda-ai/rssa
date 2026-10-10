"""Key continuity (sign.md §9): a new key is announced by a rotation statement signed by the key it
replaces, published in the card's params.rotations. A verifier that remembers a member's keys can
then tell a planned rotation from a silent key swap."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Optional

from .canonical import canonicalize
from .keys import Key, sign_detached, thumbprint, verify_detached

ROTATION_TYPE = "rssa.key-rotation"
MAX_CHAIN = 10  # longest chain of statements a verifier follows


def _public(k: dict) -> dict:
    out = {"kty": "OKP", "crv": "Ed25519", "x": k["x"]}
    if k.get("kid"):
        out["kid"] = k["kid"]
    return out


def _signed_bytes(card_url: str, prev: str, nxt: dict, at: str) -> bytes:
    return canonicalize({"type": ROTATION_TYPE, "card": card_url, "prev": prev, "next": thumbprint(nxt), "at": at}).encode("utf-8")


def rotation_statement(card_url: str, old: Key, new_public_jwk: dict, at: Optional[str] = None) -> dict:
    """The statement announcing `new_public_jwk` as the successor of `old`, for the card at `card_url`.
    Put it first in the card's params.rotations."""
    at = at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    prev = thumbprint(old.public_jwk)
    nxt = _public(new_public_jwk)
    # The JWS kid is the thumbprint, so the statement verifies whatever kid the card gives the key.
    return {"prev": prev, "next": nxt, "at": at, "sig": sign_detached(_signed_bytes(card_url, prev, nxt, at), replace(old, kid=prev))}


@dataclass
class Continuity:
    continuous: list[str]  # thumbprints already trusted, announced by a valid chain, or pinned
    unannounced: list[str]  # thumbprints with no statement or pin: a silent key change
    forks: list[str]  # keys that announced two different successors; their successors are not trusted
    trusted: list[dict]  # every trusted key after the check, as public JWKs
    edges: list[tuple[str, str]] = field(default_factory=list)  # valid statements (prev, next)
    problems: list[str] = field(default_factory=list)


def check_continuity(card_url: str, trusted: list[dict], current: list[dict], rotations: Optional[list] = None,
                     pins: Optional[list[str]] = None, seen: Optional[dict[str, str]] = None) -> Continuity:
    """Checks a card's current keys against the keys a verifier already trusts for it.
    `pins` are owner-approved thumbprints (policy members[].keys), accepted as if announced.
    `seen` maps a key to the successor it was seen to announce before; a different one now is a fork."""
    problems: list[str] = []
    tr: dict[str, dict] = {thumbprint(k): _public(k) for k in trusted}
    pin_set = set(pins or [])
    for k in current:
        if thumbprint(k) in pin_set:
            tr[thumbprint(k)] = _public(k)
    statements = [s for s in (rotations if isinstance(rotations, list) else [])[:50]
                  if isinstance(s, dict) and isinstance(s.get("prev"), str) and isinstance((s.get("next") or {}).get("x"), str)
                  and isinstance(s.get("sig"), str) and isinstance(s.get("at"), str)]
    jwks = dict(tr)
    for s in statements:
        jwks[thumbprint(s["next"])] = _public(s["next"])
    edges: dict[str, dict[str, dict]] = {}
    for s in statements:
        signer = jwks.get(s["prev"])
        if not signer:
            continue
        nxt = thumbprint(s["next"])
        ok, err = verify_detached(s["sig"], _signed_bytes(card_url, s["prev"], _public(s["next"]), s["at"]), [{**signer, "kid": s["prev"]}])
        if not ok:
            problems.append(f"rotation {s['prev']} → {nxt}: {err}")
            continue
        edges.setdefault(s["prev"], {})[nxt] = _public(s["next"])
    forks: list[str] = []
    for prev, m in edges.items():
        succ = set(m)
        if seen and seen.get(prev):
            succ.add(seen[prev])
        if len(succ) > 1:
            forks.append(prev)
            problems.append(f"key {prev} announced more than one successor ({', '.join(sorted(succ))}): trusting none of them")
    frontier = list(tr)
    for _ in range(MAX_CHAIN):
        if not frontier:
            break
        nxt_frontier = []
        for prev in frontier:
            if prev in forks:
                continue
            for t, jwk in edges.get(prev, {}).items():
                if t not in tr:
                    tr[t] = jwk
                    nxt_frontier.append(t)
        frontier = nxt_frontier
    continuous = [thumbprint(k) for k in current if thumbprint(k) in tr]
    unannounced = [thumbprint(k) for k in current if thumbprint(k) not in tr]
    return Continuity(continuous, unannounced, forks, list(tr.values()),
                      [(p, n) for p, m in edges.items() for n in m], problems)
