"""The sign module: entries are signed as a small JSON payload, never as XML."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any, Optional

from .canonical import CanonicalError, canonicalize, strict_parse
from .feed import Entry
from .keys import Key, sign_detached, verify_detached

# Payload name -> Entry attribute, copied in addition to id, updated, feed and contentHash.
BOUND_FIELDS = {"type": "type", "to": "to", "source": "source", "inReplyTo": "in_reply_to", "reaction": "reaction"}


def normalise_text(s: str) -> str:
    return re.sub(r"\r\n?", "\n", s).strip()


def content_hash_input(e: Entry) -> str:
    o = {}
    if e.summary is not None:
        o["summary"] = normalise_text(e.summary)
    if e.content is not None:
        o["content"] = normalise_text(e.content)
    return canonicalize(o)


def content_hash(e: Entry) -> str:
    return "sha256:" + hashlib.sha256(content_hash_input(e).encode("utf-8")).hexdigest()


def entry_payload(e: Entry, feed_url: str) -> dict:
    p = {"id": e.id, "updated": e.updated, "feed": feed_url, "contentHash": content_hash(e)}
    for name, attr in BOUND_FIELDS.items():
        v = getattr(e, attr)
        if v is not None:
            p[name] = v
    return p


def sign_entry(e: Entry, feed_url: str, key: Key) -> Entry:
    if e.content_type == "xhtml":
        raise ValueError(f'entry {e.id}: xhtml content cannot be signed; use type "text" or "html"')
    payload = canonicalize(entry_payload(e, feed_url))
    return replace(e, payload=payload, sig=sign_detached(payload.encode("utf-8"), key))


@dataclass
class Check:
    ok: bool
    code: str
    message: str
    explain: Optional[str] = None


@dataclass
class Verification:
    ok: bool
    checks: list[Check] = field(default_factory=list)
    payload: Optional[dict] = None


def _instant(s: Any) -> Optional[float]:
    if not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def verify_entry(e: Entry, feed_url: str, keys: list[dict]) -> Verification:
    """Verifies payload syntax, bindings to the entry and feed, content hash, and signature."""
    checks: list[Check] = []
    add = lambda ok, code, msg, explain=None: checks.append(Check(ok, code, msg, explain))
    if not e.payload or not e.sig:
        add(False, "unsigned", f"entry {e.id} has no {'<rssa:payload>' if not e.payload else '<rssa:sig>'}")
        return Verification(False, checks)
    try:
        payload = strict_parse(e.payload)
    except CanonicalError as err:
        add(False, f"payload-{err.code}", f"payload of {e.id} is not signable JSON: {err}")
        return Verification(False, checks)
    if not isinstance(payload, dict):
        add(False, "payload-shape", "payload must be a JSON object")
        return Verification(False, checks)
    canonical = canonicalize(payload)
    add(payload.get("id") == e.id, "bind-id", "payload id matches entry id" if payload.get("id") == e.id else f"payload id {payload.get('id')!r} ≠ entry id {e.id!r}")
    same = _instant(payload.get("updated")) is not None and _instant(payload.get("updated")) == _instant(e.updated)
    add(same, "bind-updated", "payload updated matches entry" if same else f"payload updated {payload.get('updated')} ≠ entry updated {e.updated}")
    add(payload.get("feed") == feed_url, "bind-feed", "payload is bound to this feed" if payload.get("feed") == feed_url else f"payload feed {payload.get('feed')!r} ≠ {feed_url!r}")
    for name, attr in BOUND_FIELDS.items():
        if payload.get(name) != getattr(e, attr):
            add(False, f"bind-{name}", f"payload {name} {payload.get(name)!r} ≠ entry {name} {getattr(e, attr)!r}")
    expected = content_hash(e)
    ok = payload.get("contentHash") == expected
    add(ok, "content-hash", "summary and content unchanged" if ok else "summary or content changed after signing",
        None if ok else f"hash input recomputed: {content_hash_input(e)} → {expected}; payload says {payload.get('contentHash')}")
    vok, err = verify_detached(e.sig, canonical.encode("utf-8"), keys)
    add(vok, "signature", "signature valid" if vok else err, None if vok else f"canonical bytes checked: {canonical}")
    return Verification(all(c.ok for c in checks), checks, payload)
