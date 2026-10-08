"""The framework-neutral tools and the LangChain / CrewAI adapters, against the demo group (served from disk)."""
import json
import pathlib
import subprocess
import sys

import pytest

from rssa.tools import UNTRUSTED, rssa_read_feed, rssa_read_group

SITE = pathlib.Path(__file__).resolve().parents[3] / "demo" / "site"
BASE = "https://demo.rssa.getvda.ai"
POLICY = f"{BASE}/groups/supply-ops/policy.json"
BREWER = f"{BASE}/brewer/rssa/feed.atom"
SEEN: list[str] = []


def fetch(url: str):
    SEEN.append(url)
    if not url.startswith(BASE):
        return 404, ""
    p = SITE / url[len(BASE) + 1:]
    return (200, p.read_text(encoding="utf-8")) if p.is_file() else (404, "")


def test_read_feed_verifies_and_marks_text_untrusted():
    r = rssa_read_feed(BREWER, fetch=fetch)
    assert r["note"] == UNTRUSTED
    assert r["kept"] >= 1 and all(e["verified"] for e in r["entries"])
    assert all("title" not in e for e in r["entries"]), "titles come back only as title_unsigned"
    assert r["entries"] == sorted(r["entries"], key=lambda e: e["updated"], reverse=True)


def test_read_group_from_policy_checks_membership_and_filters_by_type():
    r = rssa_read_group(POLICY, fetch=fetch)
    assert r["policy_verified"] is True and len(r["members"]) == 3
    only = rssa_read_group(POLICY, types=["exception."], fetch=fetch)
    assert only["kept"] >= 1 and all(e["type"].startswith("exception.") for e in only["entries"])
    assert only["kept"] < r["kept"]


def test_rejects_non_https():
    with pytest.raises(ValueError):
        rssa_read_feed("file:///etc/passwd", fetch=fetch)


def test_import_rssa_does_not_need_any_framework():
    code = "import sys, rssa, rssa.tools; assert 'langchain_core' not in sys.modules and 'crewai' not in sys.modules"
    subprocess.run([sys.executable, "-c", code], check=True)


def test_langchain_tools():
    pytest.importorskip("langchain_core")
    from rssa.integrations.langchain import rssa_tools
    tools = {t.name: t for t in rssa_tools(fetch=fetch)}
    assert set(tools) == {"rssa_read_feed", "rssa_read_group"}
    out = tools["rssa_read_group"].invoke({"url": POLICY, "types": ["exception."]})
    assert out["kept"] >= 1 and "untrusted" in tools["rssa_read_feed"].description


def test_crewai_tools():
    pytest.importorskip("crewai")
    from rssa.integrations.crewai import rssa_tools
    tools = {t.name: t for t in rssa_tools(fetch=fetch)}
    assert set(tools) == {"rssa_read_feed", "rssa_read_group"}
    out = json.loads(tools["rssa_read_feed"].run(url=BREWER, limit=1))
    assert out["returned"] == 1 and out["entries"][0]["verified"] is True


def test_langgraph_runs_the_tools_through_its_tool_node():
    pytest.importorskip("langgraph")
    from langchain_core.messages import AIMessage
    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode
    from rssa.integrations.langchain import rssa_tools
    g = StateGraph(MessagesState)
    g.add_node("tools", ToolNode(rssa_tools(fetch=fetch)))
    g.add_edge(START, "tools")
    g.add_edge("tools", END)
    call = {"name": "rssa_read_group", "args": {"url": POLICY, "types": ["exception."]}, "id": "c1", "type": "tool_call"}
    out = g.compile().invoke({"messages": [AIMessage(content="", tool_calls=[call])]})
    msg = out["messages"][-1]
    assert msg.name == "rssa_read_group" and '"kept"' in msg.content and "exception." in msg.content


def test_crewai_agent_accepts_the_tools():
    pytest.importorskip("crewai")
    from crewai import Agent
    from rssa.integrations.crewai import rssa_tools
    a = Agent(role="ops reader", goal="watch the group", backstory="reads RSS-A feeds", tools=rssa_tools(fetch=fetch), llm="gpt-4o-mini")
    assert {t.name for t in a.tools} == {"rssa_read_feed", "rssa_read_group"}
