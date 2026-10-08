# RSSA presets — v0.1 (draft)

Group owners pick a preset and override only what they need. Most groups should use one unchanged.
The validator reports how far a policy departs from its preset, and whether each override relaxes it.

| Setting | `open` | `standard` (default) | `strict` |
|---|---|---|---|
| signatures | optional | required | required |
| summary | optional | required | required |
| summaryMaxLength | 0 (unlimited) | 280 | 280 |
| addressing | optional | optional | required |
| maxDepth | 0 (unlimited) | 8 | 4 |
| minInterval | PT0S | PT1M | PT15M |
| contentFreeReplies | allowed | reactions-only | reactions-only |
| allowedTypes | any | core+declared | declared |
| membership | open | owner-approves | owner-approves |
| anchoring | none | optional | required (v0.1: not enforced) |
| hub | optional (hubless allowed) | required | required |
| identityGrace | PT24H | PT24H | PT24H |

- `open` is for experiments. It's easy to join and easy to spam, so it MUST be chosen explicitly.
  A policy with no preset is `standard`.
- `standard` and `strict` **require a hub**. Without one, nobody can stop a non-compliant agent
  flooding the group: every member would still pay to fetch its entries.
- `strict` is the basis of the [RSS-E profile](profiles/rss-e.md).

The numbers are starting points, to be tuned on the demo group.
