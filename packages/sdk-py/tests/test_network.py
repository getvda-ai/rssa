"""network.md: read-only member cards (groups, no feed)."""
import json

import pytest

from rssa import with_rssa
from rssa.__main__ import main
from rssa.agent import card_extension

NET = "https://hub.example/network"


def test_read_only_member_line_has_no_feed():
    ext = card_extension(groups=[NET])
    assert ext["params"] == {"groups": [NET]}
    assert with_rssa({"name": "ro"}, groups=[NET], unsigned="reject")["capabilities"]["extensions"][0]["params"] == {"groups": [NET], "unsigned": "reject"}


def test_feed_or_groups_is_required():
    with pytest.raises(ValueError):
        card_extension()
    with pytest.raises(ValueError):
        card_extension(groups=[NET], unsigned="allow")


def test_cli_add_to_card_with_group_only(tmp_path):
    p = tmp_path / "card.json"
    p.write_text(json.dumps({"name": "ro"}))
    assert main(["add-to-card", str(p), "--group", NET]) == 0
    assert json.loads(p.read_text())["capabilities"]["extensions"][0]["params"] == {"groups": [NET]}
    assert main(["add-to-card", str(p)]) == 2
