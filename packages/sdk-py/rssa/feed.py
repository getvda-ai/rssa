"""Parse Atom 1.0, RSS 2.0 and JSON Feed 1.1 into one entry model, and build Atom."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional
from xml.sax.saxutils import escape as _xml_escape

from defusedxml import ElementTree as ET

ATOM = "http://www.w3.org/2005/Atom"
THR = "http://purl.org/syndication/thread/1.0"
RSSA = "https://rssa.getvda.ai/ns/0.1"
CONTENT = "http://purl.org/rss/1.0/modules/content/"


@dataclass
class Entry:
    id: str
    updated: str  # RFC 3339 instant
    title: Optional[str] = None
    summary: Optional[str] = None
    content: Optional[str] = None
    content_type: Optional[str] = None
    link: Optional[str] = None
    type: Optional[str] = None
    to: Optional[str] = None
    source: Optional[str] = None
    in_reply_to: Optional[str] = None
    reaction: Optional[str] = None
    payload: Optional[str] = None
    sig: Optional[str] = None
    source_feed: Optional[str] = None
    source_card: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict) -> "Entry":
        """Accepts snake_case or the camelCase names used in JSON vectors (inReplyTo, contentType…)."""
        alias = {"inReplyTo": "in_reply_to", "contentType": "content_type", "sourceFeed": "source_feed", "sourceCard": "source_card"}
        names = {f.name for f in fields(cls)}
        return cls(**{alias.get(k, k): v for k, v in d.items() if alias.get(k, k) in names})

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class ParsedFeed:
    format: str
    title: Optional[str] = None
    self_url: Optional[str] = None
    card_url: Optional[str] = None
    hub_url: Optional[str] = None
    entries: list[Entry] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def rfc3339(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    s = s.strip()
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            d = parsedate_to_datetime(s)
        except (TypeError, ValueError):
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    d = d.astimezone(timezone.utc)
    ms = d.microsecond // 1000
    return d.strftime("%Y-%m-%dT%H:%M:%S") + (f".{ms:03d}Z" if ms else "Z")


def _t(el) -> Optional[str]:
    if el is None:
        return None
    return "".join(el.itertext())


def _links(el) -> list[tuple[str, str]]:
    return [(l.get("rel") or "alternate", l.get("href") or "") for l in el.findall(f"{{{ATOM}}}link")]


def _rel(links, rel):
    return next((h for r, h in links if r == rel), None)


def _rssa_fields(el) -> dict:
    out = {}
    for k in ("type", "to", "source", "reaction", "payload", "sig"):
        e = el.find(f"{{{RSSA}}}{k}")
        if e is not None:
            out[k] = (_t(e) or "").strip()
    irt = el.find(f"{{{THR}}}in-reply-to")
    if irt is not None:
        out["in_reply_to"] = irt.get("ref")
    return out


def parse_feed(body: str) -> ParsedFeed:
    if body.lstrip().startswith("{"):
        return _parse_json_feed(json.loads(body))
    try:
        root = ET.fromstring(body.encode("utf-8") if isinstance(body, str) else body)
    except ET.ParseError as e:
        raise ValueError(f"not well-formed XML: {e}") from None
    if root.tag == f"{{{ATOM}}}feed":
        return _parse_atom(root)
    if root.tag == "rss":
        return _parse_rss(root)
    raise ValueError(f"unrecognised feed root <{root.tag}> — expected Atom <feed>, RSS <rss> or a JSON Feed")


def _parse_atom(feed) -> ParsedFeed:
    ls = _links(feed)
    title = _t(feed.find(f"{{{ATOM}}}title"))
    out = ParsedFeed("atom", title.strip() if title else None, _rel(ls, "self"), _rel(ls, "describedby"), _rel(ls, "hub"))
    for e in feed.findall(f"{{{ATOM}}}entry"):
        id_ = (_t(e.find(f"{{{ATOM}}}id")) or "").strip() or None
        raw = (_t(e.find(f"{{{ATOM}}}updated")) or "").strip()
        updated = rfc3339(raw)
        if not id_ or not updated:
            out.problems.append(f"entry {id_ or '(no id)'}: " + ("missing <id>" if not id_ else f'missing or unparseable <updated> "{raw}"'))
            continue
        c = e.find(f"{{{ATOM}}}content")
        src = e.find(f"{{{ATOM}}}source")
        sl = _links(src) if src is not None else []
        out.entries.append(Entry(
            id=id_, updated=updated,
            title=_t(e.find(f"{{{ATOM}}}title")),
            summary=_t(e.find(f"{{{ATOM}}}summary")),
            content=_t(c),
            content_type=(c.get("type") or "text") if c is not None else None,
            link=_rel(_links(e), "alternate"),
            source_feed=_rel(sl, "self"), source_card=_rel(sl, "describedby"),
            **_rssa_fields(e),
        ))
    return out


def _parse_rss(rss) -> ParsedFeed:
    ch = rss.find("channel")
    if ch is None:
        raise ValueError("RSS feed has no <channel>")
    ls = _links(ch)
    title = _t(ch.find("title"))
    out = ParsedFeed("rss", title.strip() if title else None, _rel(ls, "self"), _rel(ls, "describedby"), _rel(ls, "hub"))
    for it in ch.findall("item"):
        id_ = (_t(it.find("guid")) or "").strip() or None
        au = it.find(f"{{{ATOM}}}updated")
        raw = (_t(au) if au is not None else _t(it.find("pubDate")) or "").strip()
        updated = rfc3339(raw)
        if not id_ or not updated:
            out.problems.append(f"item {id_ or '(no guid)'}: " + ("missing <guid>" if not id_ else f'missing or unparseable <pubDate> "{raw}"'))
            continue
        enc = it.find(f"{{{CONTENT}}}encoded")
        link = _t(it.find("link"))
        out.entries.append(Entry(
            id=id_, updated=updated,
            title=_t(it.find("title")),
            summary=_t(it.find("description")),
            content=_t(enc),
            content_type="html" if enc is not None else None,
            link=link.strip() if link else None,
            **_rssa_fields(it),
        ))
    return out


def _parse_json_feed(j: dict) -> ParsedFeed:
    if not str(j.get("version", "")).startswith("https://jsonfeed.org/version/"):
        raise ValueError("JSON is not a JSON Feed (missing version)")
    hub = next((h.get("url") for h in j.get("hubs", []) if str(h.get("type", "")).lower() == "websub"), None)
    out = ParsedFeed("json", j.get("title"), j.get("feed_url"), (j.get("_rssa") or {}).get("card"), hub)
    for it in j.get("items", []):
        id_ = str(it["id"]) if it.get("id") is not None else None
        updated = rfc3339(it.get("date_modified") or it.get("date_published"))
        if not id_ or not updated:
            out.problems.append(f"item {id_ or '(no id)'}: " + ("missing id" if not id_ else "missing date_modified/date_published"))
            continue
        r = it.get("_rssa") or {}
        payload = r.get("payload")
        if payload is not None and not isinstance(payload, str):
            payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        text = it.get("content_text")
        out.entries.append(Entry(
            id=id_, updated=updated, title=it.get("title"), summary=it.get("summary"),
            content=text if text is not None else it.get("content_html"),
            content_type="text" if text is not None else ("html" if it.get("content_html") is not None else None),
            link=it.get("url"), type=r.get("type"), to=r.get("to"), source=r.get("source"),
            in_reply_to=r.get("inReplyTo"), reaction=r.get("reaction"), payload=payload, sig=r.get("sig"),
        ))
    return out


def esc(s: str) -> str:
    """Escapes for attribute values."""
    return _xml_escape(s, {'"': "&quot;"})


def esc_text(s: str) -> str:
    """Escapes for text content (quotes stay readable, which keeps rssa:payload legible)."""
    return _xml_escape(s)


def entry_xml(e: Entry, ind: str = "") -> str:
    i2 = ind + "  "
    title = e.title if e.title is not None else ((e.summary or "")[:80] or e.type or e.id)
    l = [f"{ind}<entry>", f"{i2}<id>{esc_text(e.id)}</id>", f"{i2}<updated>{e.updated}</updated>", f"{i2}<title>{esc_text(title)}</title>"]
    if e.link:
        l.append(f'{i2}<link rel="alternate" href="{esc(e.link)}"/>')
    if e.summary is not None:
        l.append(f"{i2}<summary>{esc_text(e.summary)}</summary>")
    if e.content is not None:
        ct = e.content_type if e.content_type and e.content_type != "xhtml" else "text"
        l.append(f'{i2}<content type="{esc(ct)}">{esc_text(e.content)}</content>')
    if e.in_reply_to:
        l.append(f'{i2}<thr:in-reply-to ref="{esc(e.in_reply_to)}"/>')
    for k in ("type", "to", "source", "reaction"):
        v = getattr(e, k)
        if v is not None:
            l.append(f"{i2}<rssa:{k}>{esc_text(v)}</rssa:{k}>")
    if e.payload:
        l.append(f"{i2}<rssa:payload>{esc_text(e.payload)}</rssa:payload>")
    if e.sig:
        l.append(f"{i2}<rssa:sig>{esc_text(e.sig)}</rssa:sig>")
    if e.source_feed:
        l += [f"{i2}<source>", f"{i2}  <id>{esc_text(e.source_feed)}</id>", f'{i2}  <link rel="self" href="{esc(e.source_feed)}"/>']
        if e.source_card:
            l.append(f'{i2}  <link rel="describedby" href="{esc(e.source_card)}"/>')
        l.append(f"{i2}</source>")
    l.append(f"{ind}</entry>")
    return "\n".join(l)


def atom_xml(feed_url: str, title: str, entries: list[Entry], card_url: Optional[str] = None, hub_url: Optional[str] = None,
             feed_id: Optional[str] = None, author: Optional[str] = None) -> str:
    updated = max((e.updated for e in entries), default="1970-01-01T00:00:00Z")
    l = [
        '<?xml version="1.0" encoding="utf-8"?>',
        f'<feed xmlns="{ATOM}" xmlns:rssa="{RSSA}" xmlns:thr="{THR}">',
        f"  <id>{esc_text(feed_id or feed_url)}</id>",
        f"  <title>{esc_text(title)}</title>",
        f"  <updated>{updated}</updated>",
        f'  <link rel="self" href="{esc(feed_url)}"/>',
    ]
    if card_url:
        l.append(f'  <link rel="describedby" type="application/json" href="{esc(card_url)}"/>')
    if hub_url:
        l.append(f'  <link rel="hub" href="{esc(hub_url)}"/>')
    l.append(f"  <author><name>{esc_text(author or title)}</name></author>")
    l += [entry_xml(e, "  ") for e in entries]
    l += ["</feed>", ""]
    return "\n".join(l)


def _rfc822(instant: str) -> str:
    from email.utils import format_datetime

    return format_datetime(datetime.fromisoformat(instant.replace("Z", "+00:00")).astimezone(timezone.utc), usegmt=True)


def rss_xml(feed_url: str, title: str, entries: list[Entry], card_url: Optional[str] = None, hub_url: Optional[str] = None,
            link: Optional[str] = None, description: Optional[str] = None) -> str:
    """RSS 2.0 with the atom, content, thr and rssa namespaces. Each item carries atom:updated
    (exact instant, so edits are expressible) as well as pubDate."""
    l = [
        '<?xml version="1.0" encoding="utf-8"?>',
        f'<rss version="2.0" xmlns:atom="{ATOM}" xmlns:content="{CONTENT}" xmlns:thr="{THR}" xmlns:rssa="{RSSA}">',
        "  <channel>",
        f"    <title>{esc_text(title)}</title>",
        f"    <link>{esc_text(link or feed_url)}</link>",
        f"    <description>{esc_text(description or title)}</description>",
        f'    <atom:link rel="self" href="{esc(feed_url)}"/>',
    ]
    if card_url:
        l.append(f'    <atom:link rel="describedby" href="{esc(card_url)}"/>')
    if hub_url:
        l.append(f'    <atom:link rel="hub" href="{esc(hub_url)}"/>')
    for e in entries:
        l += ["    <item>", f'      <guid isPermaLink="false">{esc_text(e.id)}</guid>',
              f"      <pubDate>{_rfc822(e.updated)}</pubDate>", f"      <atom:updated>{e.updated}</atom:updated>"]
        if e.title is not None:
            l.append(f"      <title>{esc_text(e.title)}</title>")
        if e.link:
            l.append(f"      <link>{esc_text(e.link)}</link>")
        if e.summary is not None:
            l.append(f"      <description>{esc_text(e.summary)}</description>")
        if e.content is not None:
            l.append(f"      <content:encoded>{esc_text(e.content)}</content:encoded>")
        if e.in_reply_to:
            l.append(f'      <thr:in-reply-to ref="{esc(e.in_reply_to)}"/>')
        for k in ("type", "to", "source", "reaction", "payload", "sig"):
            v = getattr(e, k)
            if v:
                l.append(f"      <rssa:{k}>{esc_text(v)}</rssa:{k}>")
        l.append("    </item>")
    l += ["  </channel>", "</rss>", ""]
    return "\n".join(l)


def json_feed(feed_url: str, title: str, entries: list[Entry], card_url: Optional[str] = None, hub_url: Optional[str] = None,
              home_page_url: Optional[str] = None) -> str:
    """JSON Feed 1.1 with the `_rssa` extension (feed-level card link, per-item fields)."""
    doc: dict = {"version": "https://jsonfeed.org/version/1.1", "title": title, "feed_url": feed_url}
    if home_page_url:
        doc["home_page_url"] = home_page_url
    if hub_url:
        doc["hubs"] = [{"type": "WebSub", "url": hub_url}]
    if card_url:
        doc["_rssa"] = {"card": card_url}
    items = []
    for e in entries:
        it: dict = {"id": e.id, "date_modified": e.updated}
        for k, v in (("title", e.title), ("summary", e.summary), ("url", e.link)):
            if v is not None:
                it[k] = v
        if e.content is not None:
            it["content_html" if e.content_type == "html" else "content_text"] = e.content
        r = {k: v for k, v in (("type", e.type), ("to", e.to), ("source", e.source), ("inReplyTo", e.in_reply_to),
                                ("reaction", e.reaction), ("payload", e.payload), ("sig", e.sig)) if v is not None}
        if r:
            it["_rssa"] = r
        items.append(it)
    doc["items"] = items
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
