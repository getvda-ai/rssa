"""The groups and controls modules: signed policy.json, presets, entry checks, OPML export."""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

from .canonical import canonicalize
from .feed import Entry, esc
from .keys import Fetch, Key, http_get, resolve_keys, sign_detached, verify_detached

CORE_TYPES = ["brief.published", "exception.reported", "question.asked", "answer.posted",
              "decision.recorded", "reaction", "group.joined", "group.left", "agent.heartbeat"]
HEARTBEAT = "agent.heartbeat"  # a control entry: absorbed by hubs, never merged
FUTURE_SKEW_SECONDS = 300  # how far ahead of the reader's clock an entry's `updated` may be
CORE_REACTIONS = ["agree", "disagree", "ack"]
REVERSE_DOMAIN = re.compile(r"^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2,}$")

PRESETS: dict[str, dict] = {
    "open": dict(signatures="optional", summary="optional", summaryMaxLength=0, addressing="optional", maxDepth=0, minInterval="PT0S",
                 contentFreeReplies="allowed", allowedTypes="any", declaredTypes=[], membership="open", anchoring="none", hub="optional", identityGrace="PT24H",
                 rateWindow="PT1H", maxPostsPerMember=0, maxGroupPosts=0, keyContinuity="record", maxCadence=""),
    "standard": dict(signatures="required", summary="required", summaryMaxLength=280, addressing="optional", maxDepth=8, minInterval="PT1M",
                     contentFreeReplies="reactions-only", allowedTypes="core+declared", declaredTypes=[], membership="owner-approves", anchoring="optional", hub="required", identityGrace="PT24H",
                     rateWindow="PT1H", maxPostsPerMember=0, maxGroupPosts=0, keyContinuity="record", maxCadence=""),
    "strict": dict(signatures="required", summary="required", summaryMaxLength=280, addressing="required", maxDepth=4, minInterval="PT15M",
                   contentFreeReplies="reactions-only", allowedTypes="declared", declaredTypes=[], membership="owner-approves", anchoring="required", hub="required", identityGrace="PT24H",
                   rateWindow="PT1H", maxPostsPerMember=12, maxGroupPosts=60, keyContinuity="hold", maxCadence=""),
}


def effective_settings(policy: dict) -> dict:
    base = PRESETS.get(policy.get("preset") or "standard", PRESETS["standard"])
    return {**base, **{k: v for k, v in (policy.get("overrides") or {}).items() if k in base}}


def duration_seconds(d: str) -> int:
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", d)
    if not m or d == "P" or d.endswith("T"):
        raise ValueError(f"bad ISO 8601 duration {d} (use e.g. PT5M, PT1H, P1D)")
    days, h, mi, s = (int(x or 0) for x in m.groups())
    return ((days * 24 + h) * 60 + mi) * 60 + s


def _unsigned(p: dict) -> dict:
    return {k: v for k, v in p.items() if k != "sig"}


def sign_policy(policy: dict, key: Key) -> dict:
    body = _unsigned(policy)
    return {**body, "sig": sign_detached(canonicalize(body).encode("utf-8"), key)}


def verify_policy(policy: dict, fetch: Fetch = http_get) -> tuple[bool, Optional[str]]:
    if not policy.get("sig"):
        return False, "policy is unsigned (no sig field)"
    try:
        keys = resolve_keys(policy.get("owner"), fetch)
    except Exception as e:  # noqa: BLE001 - report any resolution failure
        return False, f"cannot resolve owner keys {policy.get('owner')}: {e}"
    return verify_detached(policy["sig"], canonicalize(_unsigned(policy)).encode("utf-8"), keys)


def is_known_type(t: str) -> bool:
    return t in CORE_TYPES or bool(REVERSE_DOMAIN.match(t))


def is_valid_address(to: str) -> bool:
    return to == "group" or bool(re.fullmatch(r"role:[A-Za-z0-9._-]+", to) or re.fullmatch(r"https://\S+", to) or re.fullmatch(r"did:[a-z0-9]+:\S+", to))


def _ts(iso: str) -> float:
    from datetime import datetime
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def check_entry(e: Entry, feed: str, s: dict, depth_of: Optional[Callable[[str], Optional[int]]] = None,
                root_of: Optional[Callable[[str], Optional[str]]] = None,
                last_post: Optional[Callable[[str, str], Optional[float]]] = None,
                posts_in: Optional[Callable[[Optional[str], float, float], int]] = None,
                now: Optional[float] = None) -> list[tuple[str, str]]:
    """Policy checks for one entry. Returns (code, message) violations; empty means allowed.
    posts_in(feed or None, from, to) counts accepted posts and edits with updated in (from, to] (rate caps);
    now (epoch seconds) enables the future-dated check."""
    v: list[tuple[str, str]] = []
    if now is not None and _ts(e.updated) > now + FUTURE_SKEW_SECONDS:
        v.append(("future-dated", f"updated {e.updated} is more than {FUTURE_SKEW_SECONDS // 60} minutes ahead of this reader's clock; held until then"))
    if e.type == HEARTBEAT:
        # A heartbeat is a control entry: no summary, address or declared type needed; it is never a reply.
        if e.in_reply_to:
            v.append(("heartbeat-reply", "a heartbeat cannot be a reply"))
        return v
    if s["summary"] == "required" and e.type != "reaction" and not (e.summary or "").strip():
        v.append(("summary-required", "this group requires a <summary> on every entry"))
    if s["summaryMaxLength"] and e.summary and len(e.summary.strip()) > s["summaryMaxLength"]:
        v.append(("summary-too-long", f"summary is {len(e.summary.strip())} characters; this group allows {s['summaryMaxLength']}"))
    if s["addressing"] == "required" and not e.to:
        v.append(("addressing-required", "this group requires rssa:to"))
    if e.to and not is_valid_address(e.to):
        v.append(("bad-address", f"rssa:to {e.to!r} must be group, role:<name>, an https URL or a DID"))
    if e.type:
        if not is_known_type(e.type):
            v.append(("unknown-type", f"type {e.type} is neither core nor reverse-domain"))
        elif s["allowedTypes"] == "declared" and e.type not in s["declaredTypes"]:
            v.append(("type-not-declared", f"type {e.type} is not in this group's declaredTypes"))
        elif s["allowedTypes"] == "core+declared" and e.type not in CORE_TYPES and e.type not in s["declaredTypes"]:
            v.append(("type-not-declared", f"custom type {e.type} must be listed in this group's declaredTypes"))
    elif s["allowedTypes"] != "any":
        v.append(("type-required", "this group requires rssa:type on every entry"))
    if e.type == "reaction":
        if not e.in_reply_to:
            v.append(("reaction-target", "a reaction must point at its target with thr:in-reply-to"))
        if not e.reaction:
            v.append(("reaction-value", "a reaction needs rssa:reaction"))
        elif e.reaction not in CORE_REACTIONS and not REVERSE_DOMAIN.match(e.reaction):
            v.append(("reaction-value", f"unknown reaction {e.reaction}"))
    elif e.in_reply_to and s["contentFreeReplies"] == "reactions-only":
        if not e.type:
            v.append(("content-free-reply", "replies must be typed; post a reaction to agree or acknowledge"))
        elif not ((e.content or "").strip() or e.source):
            v.append(("content-free-reply", "a reply needs content or rssa:source; use a reaction for agreement"))
    if depth_of and e.in_reply_to and e.type != "reaction":
        depth = (depth_of(e.in_reply_to) or 0) + 1
        if s["maxDepth"] and depth > s["maxDepth"]:
            v.append(("too-deep", f"reply depth {depth} exceeds maxDepth {s['maxDepth']}"))
        root = (root_of(e.in_reply_to) if root_of else None) or e.in_reply_to
        last = last_post(feed, root) if last_post else None
        from datetime import datetime
        t = datetime.fromisoformat(e.updated.replace("Z", "+00:00")).timestamp()
        gap = duration_seconds(s["minInterval"])
        if gap and last is not None and t - last < gap:
            v.append(("too-fast", f"posted {int(t - last)}s after this agent's previous post in the thread; minInterval is {s['minInterval']}"))
    caps = s.get("maxPostsPerMember", 0) or s.get("maxGroupPosts", 0)
    if posts_in and caps and e.type != "reaction":
        # Caps count posts by `updated` in the window ending at this entry, so every reader gets the same answer.
        # An edit counts too: a reader without history cannot tell an edit from a new post.
        t = _ts(e.updated)
        start = t - duration_seconds(s["rateWindow"])
        if s.get("maxPostsPerMember") and posts_in(feed, start, t) >= s["maxPostsPerMember"]:
            v.append(("member-rate", f"this agent already has {s['maxPostsPerMember']} posts in the {s['rateWindow']} before this one (maxPostsPerMember)"))
        elif s.get("maxGroupPosts") and posts_in(None, start, t) >= s["maxGroupPosts"]:
            v.append(("group-rate", f"the group already has {s['maxGroupPosts']} posts in the {s['rateWindow']} before this one (maxGroupPosts)"))
    return v


class PostLedger:
    """Accepted post times, per feed and group-wide, for the rate caps (check_entry's posts_in)."""

    def __init__(self) -> None:
        self._by_feed: dict[str, list[float]] = {}
        self._all: list[float] = []

    def add(self, feed: str, t: float) -> None:
        import bisect
        bisect.insort_right(self._all, t)
        bisect.insort_right(self._by_feed.setdefault(feed, []), t)

    def count(self, feed: Optional[str], start: float, end: float) -> int:
        """Posts with time in (start, end]."""
        import bisect
        a = self._all if feed is None else self._by_feed.get(feed, [])
        return bisect.bisect_right(a, end) - bisect.bisect_right(a, start)


def liveness(cadence: Optional[str], last_signal: Optional[float], now: float, ok: bool, slack: float = 0) -> str:
    """"No news" versus "dead": live, late, silent, undeclared or failing. A member's cadence is its
    promise to show a signal (any new or edited entry, or a heartbeat) at least that often."""
    if not ok:
        return "failing"
    if not cadence:
        return "undeclared"
    try:
        c = duration_seconds(cadence)
    except ValueError:
        return "undeclared"
    if not c:
        return "undeclared"
    age = float("inf") if last_signal is None else now - last_signal
    if age <= c + slack:
        return "live"
    if age <= 2 * c + slack:
        return "late"
    return "silent"


def cadence_problem(cadence: Any, s: dict) -> Optional[str]:
    """A member's declared cadence against the group's maxCadence: an error message, or None when it complies."""
    if not s.get("maxCadence"):
        return None
    if not isinstance(cadence, str):
        return f"this group requires params.cadence in the member's card (at most {s['maxCadence']})"
    try:
        if not duration_seconds(cadence) or duration_seconds(cadence) > duration_seconds(s["maxCadence"]):
            return f"cadence {cadence} is longer than this group's maxCadence {s['maxCadence']}"
    except ValueError:
        return f"cadence {cadence!r} is not an ISO 8601 duration"
    return None


def roster_opml(policy: dict) -> str:
    title = policy.get("name") or policy["group"]
    lines = ['<?xml version="1.0" encoding="utf-8"?>',
             f"<!-- Generated from {esc(policy['group'])} (version {policy['version']}). Membership is defined by the signed policy, not this file. -->",
             '<opml version="2.0">', f"  <head><title>{esc(title)}</title></head>", "  <body>"]
    for m in policy.get("members", []):
        role = f' category="{esc(m["role"])}"' if m.get("role") else ""
        lines.append(f'    <outline type="rss" text="{esc(m.get("name") or m["feed"])}" xmlUrl="{esc(m["feed"])}"{role}/>')
    lines += ["  </body>", "</opml>", ""]
    return "\n".join(lines)
