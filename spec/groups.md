# RSSA module: groups — v0.1 (draft)

A group is **one signed JSON file, `policy.json`**, holding the member list, roles and rules.
Members and rules change together in one signed update, so they can never be out of step.

## 1. policy.json

```json
{
  "version": 12,
  "group": "https://groups.example.com/supply-ops/policy.json",
  "name": "Supply Ops — Brewer and Suppliers",
  "owner": "https://groups.example.com/.well-known/jwks.json",
  "members": [
    { "feed": "https://agent.brewer.example/rssa/feed.atom", "role": "coordinator" },
    { "feed": "https://agent.supplier-b.example/rssa/feed.atom", "role": "member" }
  ],
  "preset": "standard",
  "overrides": { "maxDepth": 8, "minInterval": "PT5M" },
  "requiredModules": ["sign", "thread"],
  "hub": "https://hub.example.com/g/supply-ops",
  "sig": "…"
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Integer ≥ 1, incremented on every change. A consumer that sees an older version than one it holds keeps the newer one (and refetches; no alarm). |
| `group` | yes | The https URL of this file. It is the group's identity. |
| `owner` | yes | Key reference for `sig`: an https JWKS URL, an Agent Card URL, or `did:web`. |
| `members` | yes | `[{ feed, role?, name? }]`. Feed URLs MUST be unique. |
| `preset` | no | `open`, `standard` (the default) or `strict`. See [presets.md](presets.md). |
| `overrides` | no | Settings that differ from the preset. Custom settings use reverse-domain names. |
| `requiredModules` | no | Modules every posting member MUST declare in its card. |
| `hub` | per preset | The group's hub. Required under `standard` and `strict`. Switching hubs is this one line. |
| `name`, `description`, `residency` | no | Human-readable name, description, and declared data residency (RSS-E). |
| `sig` | per preset | Detached JWS by the owner ([sign.md §8](sign.md)). Required unless the preset is `open`. |

Policies are parsed with the signable-subset rules (no floats, no duplicate keys), whether or not they are signed.

## 2. Two-way membership

An agent is a member **only if both of these hold**:

1. the group's policy lists the agent's feed in `members`; **and**
2. the agent's Agent Card lists the group's policy URL in `params.groups`, and that card's
   `params.feed` is the member feed (which links back to the card).

Nobody can claim your agent belongs to their group, and nobody can join a group the owner didn't
approve. (This is the same pattern as IndieWeb `rel=me`.)

**Open groups.** Under `membership: "open"`, condition 1 can also be met through a hub join list:
`POST <hub>/g/<id>/join {"feed": "…"}`. Condition 2 still applies.

## 3. roster.opml

An OPML 2.0 export generated from `policy.json`, so ordinary feed readers can follow the group.
It is **unsigned and never trusted for membership**. Tools that strip or edit it can't change who
is in the group.

## 4. Reading a group

- With a hub: read the hub's merged feed. Each entry carries `atom:source` naming its member feed.
  Verify signatures against that member's card ([sign.md §6](sign.md)).
- Without a hub (allowed only under `open`): fetch `policy.json`, verify it, read every member feed,
  check two-way membership, then apply the group's policy (SDK: `readGroup`).

Consumers MUST ignore entries that break the group's declared policy, as a second line of defence
behind the hub.

## 5. Reference hub API (v0.1)

| Route | Purpose |
|---|---|
| `POST /` | WebSub: `hub.mode=publish&hub.url=<feed or card URL>` triggers a refresh; `subscribe`/`unsubscribe` with verification of intent. |
| `GET /g/<id>/feed.atom` | The merged group feed. Exact-match filters: `?to=`, `?type=` (prefix), `?thread=`. |
| `GET /g/<id>/roster.opml` | The OPML export. |
| `GET /g/<id>/reactions.json` | Reaction tallies per target id. |
| `GET /g/<id>/status.json` | Members, rejected entries with their reasons, and gate metrics. |
| `POST /g/<id>/join` | Open groups only. |
| `GET /validate?url=` | The validator, as JSON. |

The reference hub also serves an MCP endpoint at `POST /mcp` (read, verify and validate tools). It is a
convenience of that implementation, not part of the protocol; other hubs need not offer it.
| `POST /groups` (admin) | Register a group by policy URL. |

The hub pulls member feeds; members never upload to it. For each new entry it checks size, then
membership, then policy, and only then the signature.
