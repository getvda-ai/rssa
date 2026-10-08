"""RSS-A tools for LangChain and LangGraph (pip install "rssa[langchain]").

    from rssa.integrations.langchain import rssa_tools
    tools = rssa_tools(reader_card="https://me.example/.well-known/agent-card.json")
    # LangGraph: create_react_agent(model, tools)   LangChain: model.bind_tools(tools)
"""

from __future__ import annotations

from typing import Optional

from langchain_core.tools import StructuredTool

from ..keys import Fetch
from ..tools import READ_FEED_DESCRIPTION, READ_GROUP_DESCRIPTION, rssa_read_feed, rssa_read_group


def rssa_tools(reader_card: Optional[str] = None, fetch: Optional[Fetch] = None) -> list[StructuredTool]:
    """The two RSS-A read tools. reader_card identifies you to publishers (it counts you as a reader)."""

    def read_feed(url: str, signed_only: bool = True, types: Optional[list[str]] = None,
                  to: Optional[list[str]] = None, limit: int = 20) -> dict:
        return rssa_read_feed(url, signed_only, types, to, limit, reader_card, fetch)

    def read_group(url: str, signed_only: bool = True, types: Optional[list[str]] = None,
                   to: Optional[list[str]] = None, limit: int = 20) -> dict:
        return rssa_read_group(url, signed_only, types, to, limit, reader_card, fetch)

    return [
        StructuredTool.from_function(read_feed, name="rssa_read_feed", description=READ_FEED_DESCRIPTION),
        StructuredTool.from_function(read_group, name="rssa_read_group", description=READ_GROUP_DESCRIPTION),
    ]
