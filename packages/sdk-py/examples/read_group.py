"""Read a live RSS-A group the way an agent would: verified entries only, filtered by plain code.

    python packages/sdk-py/examples/read_group.py [group feed or policy.json URL]

The same functions back the LangChain/LangGraph and CrewAI tools (rssa.integrations) and the MCP server.
"""
import sys

from rssa.tools import rssa_read_group

URL = sys.argv[1] if len(sys.argv) > 1 else "https://hub.rssa.getvda.ai/g/6a3a4c228e34/feed.atom"

r = rssa_read_group(URL, limit=10)
print(f"{r['kept']} of {r['read']} entries verified and kept; newest {r['returned']}:\n")
for e in r["entries"]:
    who = e["from"].rsplit("/feeds/", 1)[-1] if "/feeds/" in e["from"] else e["from"]
    print(f"{e['updated']}  {e.get('type', '-'):24} {who:40} {(e.get('summary') or '')[:90]}")
for p in r["problems"]:
    print("problem:", p)
