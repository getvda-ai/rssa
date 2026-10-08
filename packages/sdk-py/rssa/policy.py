"""The groups and controls modules: signed policy.json, presets, entry checks, OPML export."""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

from .canonical import canonicalize
from .feed import Entry, esc
from .keys import Fetch, Key, http_get, resolve_keys, sign_detached, verify_detached

CORE_TYPES = ["brief.published", "exception.reported", "question.asked", "answer.posted",
              "decision.recorded", "reaction", "group.joined", "group.left"]
CORE_REACTIONS = ["agree", "disagree", "ack"]
REVERSE_DOMAIN = re.compile(r"^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2,}$")

PRESETS: dict[str, dict] = {
    "open": dict(signatures="optional", summary="optional", summaryMaxLength=0, addressing="optional", maxDepth=0, minInterval="PT0S",
                 contentFreeReplies="allowed", allowedTypes="any", declaredTypes=[], membership="open", anchoring="none", hub="optional", identityGrace="PT24H"),
    "standard": dict(signatures="required", summary="required", summaryMaxLength=280, addressing="optional", maxDepth=8, minInterval="PT1M",
                     contentFreeReplies="reactions-only", allowedTypes="core+declared", declaredTypes=[], membership="owner-approves", anchoring="optional", hub="required", identityGrace="PT24H"),
    "strict": dict(signatures="required", summary="required", summaryMaxLength=280, addressing="required", maxDepth=4, minInterval="PT15M",
                   contentFreeReplies="reactions-only", allowedTypes="declared", declaredTypes=[], membership="owner-approves", anchoring="required", hub="required", identityGrace="PT24H"),
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


def check_entry(e: Entry, feed: str, s: dict, depth_of: Optional[Callable[[str], Optional[int]]] = None,
                root_of: Optional[Callable[[str], Optional[str]]] = None,
                last_post: Optional[Callable[[str, str], Optional[float]]] = None) -> list[tuple[str, str]]:
    """Policy checks for one entry. Returns (code, message) violations; empty means allowed."""
    v: list[tuple[str, str]] = []
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
    return v


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
