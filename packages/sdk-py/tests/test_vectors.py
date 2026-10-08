import json
import pathlib

import pytest

import rssa
from rssa import CanonicalError, Entry, canonicalize, key_from_jwk, sign_entry, strict_parse, verify_entry, verify_policy

V = pathlib.Path(__file__).resolve().parents[3] / "test-vectors"


def load(n):
    return json.loads((V / n).read_text(encoding="utf-8"))


@pytest.mark.parametrize("v", load("canonical.json")["valid"], ids=lambda v: v["name"])
def test_canonical_valid(v):
    assert canonicalize(strict_parse(v["input"])) == v["canonical"]
    assert canonicalize(strict_parse(v["input"])).encode("utf-8").hex() == v["canonicalHex"]


@pytest.mark.parametrize("v", load("canonical.json")["invalid"], ids=lambda v: v["name"])
def test_canonical_invalid(v):
    with pytest.raises(CanonicalError) as e:
        strict_parse(v["input"])
    assert e.value.code == v["error"]


def test_entries_resign_and_verify():
    f = load("entries.json")
    key = key_from_jwk(f["privateJwk"])
    assert key.kid == f["kid"] == rssa.thumbprint(f["publicJwk"])
    for v in f["vectors"]:
        e = Entry.from_dict(v["entry"])
        assert rssa.content_hash_input(e) == v["contentHashInput"]
        assert rssa.content_hash(e) == v["contentHash"]
        s = sign_entry(e, v["feed"], key)
        assert s.payload == v["payloadCanonical"]
        assert s.sig == v["sig"]
        r = verify_entry(Entry.from_dict({**v["entry"], "payload": v["payloadCanonical"], "sig": v["sig"]}), v["feed"], [f["publicJwk"]])
        assert r.ok, [c for c in r.checks if not c.ok]


@pytest.mark.parametrize("v", load("entries-invalid.json")["vectors"], ids=lambda v: v["name"])
def test_entries_invalid(v):
    pub = load("entries.json")["publicJwk"]
    r = verify_entry(Entry.from_dict({**v["entry"], "payload": v["payload"], "sig": v["sig"]}), v["feed"], [pub])
    assert not r.ok
    assert v["failsCheck"] in [c.code for c in r.checks if not c.ok]


def test_policy():
    f = load("policy.json")
    fetch = lambda url: (200, json.dumps({"keys": [f["ownerPublicJwk"]]}))
    assert verify_policy(f["policy"], fetch)[0]
    assert not verify_policy({**f["policy"], "version": 13}, fetch)[0]
    assert canonicalize({k: v for k, v in f["policy"].items() if k != "sig"}) == f["canonicalUnsigned"]


def test_build_parse_roundtrip():
    key = rssa.generate_key()
    url = "https://a.example/rssa/feed.atom"
    e = rssa.entry("t", "summary\r\nline", "body & <b>", type="brief.published", to="group")
    xml = rssa.build_feed(url, "A", [e], key=key, card_url="https://a.example/.well-known/agent-card.json")
    parsed = rssa.parse_feed(xml)
    assert parsed.self_url == url and parsed.card_url.endswith("agent-card.json")
    assert verify_entry(parsed.entries[0], url, [key.public_jwk]).ok


def test_local_filter():
    mk = lambda **kw: rssa.ReadEntry(rssa.entry("t", "s", **kw), True, "https://a.example/f")
    items = [mk(type="exception.reported", to="role:logistics"), mk(type="brief.published"), mk(type="exception.reported", to="role:sales")]
    got = rssa.local_filter(items, types=["exception."], to=["role:logistics", "group"])
    assert [r.entry.to for r in got] == ["role:logistics"]


@pytest.mark.parametrize("fmt", ["atom", "rss", "json"])
def test_build_every_format_roundtrips_and_verifies(fmt):
    key = rssa.generate_key()
    url = f"https://a.example/rssa/feed.{fmt}"
    q = rssa.entry("Q", "Question?\r\nwith CRLF", "Body & <tags> \"quoted\"", type="question.asked", to="group",
                   source="https://a.example/s", updated="2026-10-05T09:00:00Z")
    r = rssa.entry(None, None, None, type="reaction", reaction="ack", in_reply_to=q.id, updated="2026-10-05T09:01:00Z")
    edited = rssa.entry("Q2", "Edited", "x", id="tag:a.example,2026:e", updated="2026-10-05T10:00:00.250Z")
    body = rssa.build_feed(url, "A & B", [q, r, edited], key=key, card_url="https://a.example/card.json",
                           hub_url="https://hub.example/", format=fmt)
    p = rssa.parse_feed(body)
    assert p.format == fmt and p.self_url == url and p.card_url == "https://a.example/card.json" and p.hub_url == "https://hub.example/"
    assert len(p.entries) == 3 and not p.problems
    for e in p.entries:
        v = verify_entry(e, url, [key.public_jwk])
        assert v.ok, (e.id, [c.message for c in v.checks if not c.ok])
    got = {e.id: e for e in p.entries}
    assert got[r.id].in_reply_to == q.id and got[r.id].reaction == "ack"
    assert got["tag:a.example,2026:e"].updated == "2026-10-05T10:00:00.250Z"


def test_read_group_on_demo_matches_the_js_reader():
    site = V.parent / "demo" / "site"
    base = "https://demo.rssa.getvda.ai"

    def fetch(url):  # serves demo/site offline
        p = site.joinpath(*url[len(base):].strip("/").split("/")) if url.startswith(base) else None
        return (200, p.read_text(encoding="utf-8")) if p and p.is_file() else (404, "")

    g = rssa.read_group("https://demo.rssa.getvda.ai/groups/supply-ops/policy.json", fetch=fetch)
    assert g.policy_verified, g.problems
    assert not g.problems, g.problems
    # 6 posts: question, exception, answer, ack reaction, decision, brief — none breaks the standard preset
    assert len(g.entries) == 6
    assert all(r.verified for r in g.entries)


def test_verify_explains_a_card_without_the_rssa_line():
    key = rssa.generate_key()
    url = "https://a.example/feed.atom"
    xml = rssa.build_feed(url, "A", [rssa.entry("t", "s", "c")], key=key, card_url="https://a.example/card.json")
    pages = {url: xml, "https://a.example/card.json": '{"name":"A","capabilities":{}}'}
    r = rssa.read_feed(url, fetch=lambda u: (200, pages[u]) if u in pages else (404, ""), require_signatures=False)
    msg = [c.message for c in r.entries[0].checks if not c.ok and c.code == "signature"][0]
    assert "has no RSS-A line yet" in msg
