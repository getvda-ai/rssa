"""High-level helpers: the Agent Card line, publishing, reading and local filtering."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Optional

from .feed import Entry, ParsedFeed, atom_xml, json_feed, parse_feed, rss_xml
from .keys import Fetch, Key, get_json, http_get, resolve_keys
from .sign import Check, sign_entry, verify_entry

EXT_URI = "https://rssa.getvda.ai/ext/v0.1"
EXT_PREFIX = "https://rssa.getvda.ai/ext/"
USER_AGENT = "rssa-sdk-py/0.1 (+https://rssa.getvda.ai)"


def card_extension(feed: str, modules: Optional[list[str]] = None, hub: Optional[str] = None,
                   groups: Optional[list[str]] = None, keys: Any = None) -> dict:
    """The one Agent Card line. Put it in card["capabilities"]["extensions"]."""
    params: dict = {"feed": feed}
    if modules:
        params["modules"] = modules
    if hub:
        params["hub"] = hub
    if groups:
        params["groups"] = groups
    if keys:
        params["keys"] = keys
    return {"uri": EXT_URI, "description": "RSSA: this agent's feed and modules", "required": False, "params": params}


def with_rssa(card: dict, **params) -> dict:
    """Returns a copy of an Agent Card with the RSSA extension added or replaced."""
    caps = dict(card.get("capabilities") or {})
    exts = [e for e in caps.get("extensions", []) if not str(e.get("uri", "")).startswith(EXT_PREFIX)]
    caps["extensions"] = exts + [card_extension(**params)]
    return {**card, "capabilities": caps}


def find_rssa(card: Any) -> Optional[dict]:
    for e in ((card or {}).get("capabilities") or {}).get("extensions", []):
        if str(e.get("uri", "")).startswith(EXT_PREFIX):
            return e
    return None


def card_modules(card: Any) -> list[str]:
    ext = find_rssa(card)
    return [str(m).split("@")[0] for m in ((ext or {}).get("params") or {}).get("modules", [])]


def sign_card(card: dict, key: Key) -> dict:
    """Signs an Agent Card with A2A's native `signatures` field (JWS over the RFC 8785 canonical card).
    Re-sign after every change to the card."""
    from .canonical import canonicalize
    from .keys import sign_detached

    body = {k: v for k, v in card.items() if k != "signatures"}
    protected, _, signature = sign_detached(canonicalize(body).encode("utf-8"), key).split(".")
    return {**body, "signatures": [{"protected": protected, "signature": signature}]}


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def entry(title: Optional[str] = None, summary: Optional[str] = None, content: Optional[str] = None, *,
          type: Optional[str] = None, to: Optional[str] = None, source: Optional[str] = None,
          in_reply_to: Optional[str] = None, reaction: Optional[str] = None, id: Optional[str] = None,
          updated: Optional[str] = None, link: Optional[str] = None, content_type: Optional[str] = None) -> Entry:
    """A new entry with a urn:uuid id and the current time (whole seconds) unless given."""
    return Entry(id=id or f"urn:uuid:{uuid.uuid4()}", updated=updated or now(), title=title, summary=summary, content=content,
                 content_type=content_type, link=link, type=type, to=to, source=source, in_reply_to=in_reply_to, reaction=reaction)


# Content-Type to serve each format with.
MEDIA_TYPES = {"atom": "application/atom+xml", "rss": "application/rss+xml", "json": "application/feed+json"}


def build_feed(feed_url: str, title: str, entries: list[Entry], key: Optional[Key] = None, card_url: Optional[str] = None,
               hub_url: Optional[str] = None, author: Optional[str] = None, format: str = "atom") -> str:
    """Builds a complete feed: format "atom" (default), "rss" (RSS 2.0) or "json" (JSON Feed 1.1).
    With a key every entry is signed. Returns a string: store it wherever your platform keeps
    files (disk, GCS, S3, a route handler) and serve it with MEDIA_TYPES[format]."""
    if format not in MEDIA_TYPES:
        raise ValueError(f"format must be one of {sorted(MEDIA_TYPES)}")
    seen = set()
    for e in entries:
        if e.id in seen:
            raise ValueError(f"duplicate entry id {e.id}")
        seen.add(e.id)
    ordered = sorted(entries, key=lambda e: e.updated, reverse=True)
    if key:
        ordered = [sign_entry(e, feed_url, key) for e in ordered]
    if format == "rss":
        return rss_xml(feed_url, title, ordered, card_url=card_url, hub_url=hub_url)
    if format == "json":
        return json_feed(feed_url, title, ordered, card_url=card_url, hub_url=hub_url)
    return atom_xml(feed_url, title, ordered, card_url=card_url, hub_url=hub_url, author=author)


def ping_hub(hub_url: str, feed_url: str) -> int:
    """Tells a WebSub hub the feed changed. Never raises; returns the HTTP status (0 on network error)."""
    import urllib.parse
    import urllib.request

    data = urllib.parse.urlencode({"hub.mode": "publish", "hub.url": feed_url}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(hub_url, data=data, headers={"User-Agent": USER_AGENT}), timeout=10) as r:
            return r.status
    except Exception as e:  # noqa: BLE001
        return getattr(e, "code", 0)


@dataclass
class ReadEntry:
    entry: Entry
    verified: bool
    source: str  # the feed the entry is attributed to
    checks: list[Check] = field(default_factory=list)

    def __getattr__(self, name):  # entry fields read through: r.type, r.summary …
        return getattr(self.entry, name)


@dataclass
class FeedRead:
    feed: ParsedFeed
    card: Optional[dict]
    keys: list[dict]
    entries: list[ReadEntry]
    problems: list[str]


def read_feed(url: str, fetch: Optional[Fetch] = None, require_signatures: Optional[bool] = None, reader_card: Optional[str] = None) -> FeedRead:
    """Fetches a feed, follows rel=describedby to the card, checks it points back, verifies signatures.
    Pass reader_card (your own Agent Card URL) so publishers and hubs can count real subscribers."""
    ua = f"{USER_AGENT} reader={reader_card}" if reader_card else USER_AGENT
    fetch = fetch or (lambda u: http_get(u, accept="application/atom+xml, application/rss+xml, application/feed+json, application/json", user_agent=ua))
    status, text = fetch(url)
    if status != 200:
        raise ValueError(f"GET {url} returned {status}")
    feed = parse_feed(text)
    problems = list(feed.problems)
    feed_url = feed.self_url or url
    card, keys = None, []
    no_keys_reason = None if feed.card_url else "the feed has no rel=describedby link to an Agent Card, so there are no keys to check against"
    if feed.card_url:
        try:
            card = get_json(feed.card_url, fetch)
            ext = find_rssa(card)
            if not ext:
                problems.append(f"card {feed.card_url} has no RSSA extension")
                no_keys_reason = f"the Agent Card {feed.card_url} has no RSS-A line yet, so it does not vouch for this feed or publish keys"
            elif ext["params"].get("feed") != feed_url:
                problems.append(f"card names feed {ext['params'].get('feed')}, not {feed_url} — it does not vouch for this feed")
                no_keys_reason = f"the Agent Card names feed {ext['params'].get('feed')}, not this one, so its keys do not apply here"
            elif ext["params"].get("keys"):
                keys = resolve_keys(ext["params"]["keys"], fetch)
        except Exception as e:  # noqa: BLE001
            problems.append(f"card: {e}")
    if require_signatures is None:
        require_signatures = "sign" in card_modules(card)
    out = []
    for e in feed.entries:
        attributed = e.source_feed or feed_url
        if not e.sig:
            if require_signatures:
                problems.append(f"dropped unsigned entry {e.id}")
            else:
                out.append(ReadEntry(e, False, attributed))
            continue
        k = keys
        if e.source_feed and e.source_feed != feed_url and e.source_card:
            try:
                c = get_json(e.source_card, fetch)
                x = find_rssa(c)
                k = resolve_keys(x["params"]["keys"], fetch) if x and x["params"].get("feed") == e.source_feed and x["params"].get("keys") else []
            except Exception:  # noqa: BLE001
                k = []
        v = verify_entry(e, attributed, k)
        if not k and attributed == feed_url and no_keys_reason:
            # Say why there is nothing to verify against, instead of a bare key-id error.
            v.checks = [c for c in v.checks if c.code != "signature"] + [Check(False, "signature", f"cannot verify: {no_keys_reason}")]
        if v.ok or not require_signatures:
            out.append(ReadEntry(e, v.ok, attributed, v.checks))
        else:
            problems.append(f"dropped entry {e.id}: " + "; ".join(c.message for c in v.checks if not c.ok))
    return FeedRead(feed, card, keys, out, problems)


def local_filter(entries: list[ReadEntry], signed_only: bool = False, types: Optional[list[str]] = None,
                 to: Optional[list[str]] = None, sources: Optional[list[str]] = None) -> list[ReadEntry]:
    """Consumer-side guardrail, applied with plain code before any model reads an entry.
    Type patterns ending in "." match prefixes ("exception."). Entries without rssa:to count as "group"."""
    def type_ok(t):
        return types is None or (t is not None and any(t == p or (p.endswith(".") and t.startswith(p)) for p in types))
    return [r for r in entries
            if (not signed_only or r.verified) and type_ok(r.entry.type)
            and (to is None or (r.entry.to or "group") in to) and (sources is None or r.source in sources)]


@dataclass
class GroupRead:
    policy: dict
    policy_verified: bool
    entries: list[ReadEntry]  # newest first
    problems: list[str]


def read_group(policy_url: str, fetch: Optional[Fetch] = None, reader_card: Optional[str] = None) -> GroupRead:
    """Hubless group reading (open groups, two-party links, or checking a hub): fetches and
    verifies the policy, reads every member feed, checks two-way membership, then applies
    the group's policy in time order. Dropped entries are listed in `problems` with the reason."""
    from datetime import datetime as _dt

    from .policy import check_entry, effective_settings, verify_policy

    ua = f"{USER_AGENT} reader={reader_card}" if reader_card else USER_AGENT
    fetch = fetch or (lambda u: http_get(u, accept="application/atom+xml, application/rss+xml, application/feed+json, application/json", user_agent=ua))
    policy = get_json(policy_url, fetch)
    problems: list[str] = []
    pok, perr = verify_policy(policy, fetch)
    if not pok:
        problems.append(f"policy signature: {perr}")
    s = effective_settings(policy)
    refs = {policy.get("group"), policy_url}
    every: list[ReadEntry] = []
    for m in policy.get("members", []):
        try:
            fr = read_feed(m["feed"], fetch=fetch, require_signatures=s["signatures"] == "required" or None)
        except Exception as e:  # noqa: BLE001
            problems.append(f"{m['feed']}: {e}")
            continue
        groups = (((find_rssa(fr.card) or {}).get("params")) or {}).get("groups") or []
        if not refs & set(groups):
            problems.append(f"{m['feed']}: its Agent Card does not list this group — not a member (two-way membership)")
            continue
        problems += [f"{m['feed']}: {p}" for p in fr.problems]
        every += fr.entries
    ts = lambda r: _dt.fromisoformat(r.entry.updated.replace("Z", "+00:00")).timestamp()
    every.sort(key=ts)
    depth: dict[str, int] = {}
    root: dict[str, str] = {}
    last: dict[str, float] = {}
    kept: list[ReadEntry] = []
    for r in every:
        e = r.entry
        v = check_entry(e, r.source, s, depth_of=depth.get, root_of=root.get, last_post=lambda f, rt: last.get(f"{f} {rt}"))
        if v:
            problems.append(f"dropped {e.id}: " + "; ".join(m for _, m in v))
            continue
        d = depth.get(e.in_reply_to, 0) + 1 if e.in_reply_to else 0
        rt = root.get(e.in_reply_to, e.in_reply_to) if e.in_reply_to else e.id
        depth[e.id], root[e.id] = d, rt
        last[f"{r.source} {rt}"] = ts(r)
        kept.append(r)
    return GroupRead(policy, pok, list(reversed(kept)), problems)
