"""v0.2 additions against the shared vectors: rotation statements, key continuity and the new controls."""

import json
import pathlib
from datetime import datetime

import pytest

import rssa
from rssa import Entry, PostLedger, check_continuity, check_entry, key_from_jwk, liveness, rotation_statement, thumbprint
from rssa.canonical import canonicalize

V = pathlib.Path(__file__).resolve().parents[3] / "test-vectors"
ROT = json.loads((V / "rotation.json").read_text(encoding="utf-8"))
CTRL = json.loads((V / "controls.json").read_text(encoding="utf-8"))


def ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def test_rotation_statement_is_reproduced_byte_for_byte():
    keys = {k: key_from_jwk(v) for k, v in ROT["privateJwks"].items()}
    st = ROT["statement"]
    got = rotation_statement(ROT["card"], keys[st["from"]], keys[st["to"]].public_jwk, ROT["at"])
    assert got == st["value"]
    assert canonicalize({"type": "rssa.key-rotation", "card": ROT["card"], "prev": got["prev"], "next": thumbprint(got["next"]), "at": ROT["at"]}) == st["signedInput"]


@pytest.mark.parametrize("c", ROT["cases"], ids=lambda c: c["name"])
def test_continuity_cases(c):
    r = check_continuity(ROT["card"], c["trusted"], c["current"], c["rotations"], c.get("pins"), c.get("seen"))
    assert {"continuous": r.continuous, "unannounced": r.unannounced, "forks": r.forks} == c["expect"]


@pytest.mark.parametrize("c", CTRL["cases"], ids=lambda c: c["name"])
def test_controls_cases(c):
    s = {**rssa.PRESETS[c["preset"]], **c["overrides"]}
    e = c["entry"]
    entry = Entry(id=e["id"], updated=e["updated"], summary=e.get("summary"), type=e.get("type"), to=e.get("to"),
                  in_reply_to=e.get("inReplyTo"), reaction=e.get("reaction"))
    posts = [(f, ts(u)) for f, u in c["posts"]]
    posts_in = lambda f, a, b: sum(1 for pf, pt in posts if (f is None or pf == f) and a < pt <= b)
    v = check_entry(entry, c["feed"], s, depth_of=lambda _: None, root_of=lambda _: None, last_post=lambda *_: None,
                    posts_in=posts_in, now=ts(CTRL["now"]))
    assert [code for code, _ in v] == c["codes"]


def test_post_ledger_counts_half_open_windows():
    led = PostLedger()
    for f, t in [("a", 10), ("a", 20), ("b", 20), ("a", 30)]:
        led.add(f, t)
    assert led.count("a", 10, 30) == 2
    assert led.count(None, 10, 30) == 3
    assert led.count("c", 0, 100) == 0


def test_liveness_states():
    assert liveness("PT1H", 0, 3600, True) == "live"
    assert liveness("PT1H", 0, 3601, True) == "late"
    assert liveness("PT1H", 0, 7201, True) == "silent"
    assert liveness("PT1H", None, 10, True) == "silent"
    assert liveness(None, 0, 10, True) == "undeclared"
    assert liveness("PT1H", 0, 10, False) == "failing"


def test_heartbeat_helper_is_a_signable_control_entry():
    k = key_from_jwk(ROT["privateJwks"]["A"])
    hb = rssa.sign_entry(rssa.heartbeat("tag:a.example,2026:heartbeat", "2026-10-10T12:00:00Z"), "https://a.example/feed.atom", k)
    assert hb.type == "agent.heartbeat"
    assert rssa.verify_entry(hb, "https://a.example/feed.atom", [k.public_jwk]).ok
    assert check_entry(hb, "https://a.example/feed.atom", rssa.PRESETS["strict"]) == []


def test_read_group_applies_the_group_cap_in_one_global_order_and_reports_liveness():
    """Two members, maxGroupPosts 3: the three earliest posts win whichever member wrote them; heartbeats feed liveness."""
    base = "https://py.test"
    owner = key_from_jwk(ROT["privateJwks"]["D"])
    keys = [key_from_jwk(ROT["privateJwks"]["A"]), key_from_jwk(ROT["privateJwks"]["B"])]
    policy_url = f"{base}/policy.json"
    docs = {f"{base}/owner.json": json.dumps({"keys": [owner.public_jwk]})}
    now = ts("2026-10-10T12:00:00Z")
    at = lambda m: datetime.fromtimestamp(now - m * 60, tz=__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    posts = {0: [50, 30, 10], 1: [40, 20]}
    for i, k in enumerate(keys):
        feed, card = f"{base}/a{i}/feed.atom", f"{base}/a{i}/card.json"
        es = [Entry(id=f"tag:py.test,2026:{i}-{m}", updated=at(m), summary=f"{i} {m}", type="brief.published") for m in posts[i]]
        if i == 0:
            es.append(rssa.heartbeat("tag:py.test,2026:hb0", at(2)))
        docs[feed] = rssa.build_feed(feed, f"a{i}", es, key=k, card_url=card)
        docs[card] = json.dumps(rssa.with_rssa({"name": f"a{i}"}, feed=feed, modules=["sign", "groups"], groups=[policy_url], keys=k.public_jwks(),
                                               cadence="PT1H" if i == 0 else None))
    docs[policy_url] = json.dumps(rssa.sign_policy({"version": 1, "group": policy_url, "owner": f"{base}/owner.json",
                                                    "members": [{"feed": f"{base}/a1/feed.atom"}, {"feed": f"{base}/a0/feed.atom"}],
                                                    "overrides": {"maxGroupPosts": 3, "rateWindow": "PT2H"}}, owner))
    g = rssa.read_group(policy_url, fetch=lambda u: (200, docs[u]) if u in docs else (404, ""), now_ts=now)
    assert sorted(r.entry.id for r in g.entries) == sorted(["tag:py.test,2026:0-50", "tag:py.test,2026:1-40", "tag:py.test,2026:0-30"])
    assert sum("maxGroupPosts" in p for p in g.problems) == 2
    assert g.liveness[f"{base}/a0/feed.atom"]["state"] == "live"
    assert g.liveness[f"{base}/a1/feed.atom"]["state"] == "undeclared"
