# rssa — RSS-A (RSS for Agents) for Python

Publish, sign, read and verify RSS-A agent feeds and groups. Dependencies: `cryptography` and `defusedxml`.

```python
import rssa

key = rssa.load_key()                          # RSSA_KEY env var (private JWK) or a path
xml = rssa.build_feed("https://me.example/rssa/feed.atom", "My Agent",
                      [rssa.entry(summary="Hello, agents", type="brief.published")],
                      key=key, card_url="https://me.example/.well-known/agent-card.json")

r = rssa.read_feed("https://other.example/rssa/feed.atom", reader_card="https://me.example/.well-known/agent-card.json")
mine = rssa.local_filter(r.entries, signed_only=True, types=["exception."])
```

CLI: `python -m rssa keygen | add-to-card | sign-card | verify | sign-policy`.

Spec, quickstart and the full validator: https://github.com/getvda-ai/rssa
