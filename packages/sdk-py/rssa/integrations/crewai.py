"""RSS-A tools for CrewAI (pip install "rssa[crewai]").

    from rssa.integrations.crewai import rssa_tools
    agent = Agent(role=..., goal=..., backstory=..., tools=rssa_tools(reader_card=MY_CARD))
"""

from __future__ import annotations

import json
from typing import Optional

from crewai.tools import BaseTool
from pydantic import BaseModel, Field

from ..keys import Fetch
from ..tools import READ_FEED_DESCRIPTION, READ_GROUP_DESCRIPTION, rssa_read_feed, rssa_read_group


class _ReadArgs(BaseModel):
    url: str = Field(description="Feed URL, hub group feed URL, or group policy.json URL (https).")
    signed_only: bool = Field(default=True, description="Only entries whose signature verified.")
    types: Optional[list[str]] = Field(default=None, description='Entry types to keep; a trailing dot is a prefix, e.g. ["exception."].')
    to: Optional[list[str]] = Field(default=None, description='Addressees to keep, e.g. ["group", "role:ops"].')
    limit: int = Field(default=20, description="Newest entries to return (1-100).")


class RssaReadFeedTool(BaseTool):
    name: str = "rssa_read_feed"
    description: str = READ_FEED_DESCRIPTION
    args_schema: type[BaseModel] = _ReadArgs
    reader_card: Optional[str] = None
    fetch: Optional[Fetch] = None

    def _run(self, url: str, signed_only: bool = True, types: Optional[list[str]] = None, to: Optional[list[str]] = None, limit: int = 20) -> str:
        return json.dumps(rssa_read_feed(url, signed_only, types, to, limit, self.reader_card, self.fetch), indent=2)


class RssaReadGroupTool(BaseTool):
    name: str = "rssa_read_group"
    description: str = READ_GROUP_DESCRIPTION
    args_schema: type[BaseModel] = _ReadArgs
    reader_card: Optional[str] = None
    fetch: Optional[Fetch] = None

    def _run(self, url: str, signed_only: bool = True, types: Optional[list[str]] = None, to: Optional[list[str]] = None, limit: int = 20) -> str:
        return json.dumps(rssa_read_group(url, signed_only, types, to, limit, self.reader_card, self.fetch), indent=2)


def rssa_tools(reader_card: Optional[str] = None, fetch: Optional[Fetch] = None) -> list[BaseTool]:
    """The two RSS-A read tools for a CrewAI Agent."""
    return [RssaReadFeedTool(reader_card=reader_card, fetch=fetch), RssaReadGroupTool(reader_card=reader_card, fetch=fetch)]
