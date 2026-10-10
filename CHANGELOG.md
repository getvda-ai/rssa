# Changelog

## 0.2.0: key continuity, liveness, group-wide rate caps (2026-10-10)

Spec v0.2 is a strict superset of v0.1: optional card params, policy settings and one entry type, all ignored
by v0.1 readers. The extension URI stays `https://rssa.getvda.ai/ext/v0.1`.

**Credit: Tercel**, whose review questions about key continuity, telling a quiet agent from a stopped one,
group-wide storm control and reputation led to every feature in this release. The design was then reviewed by
Gemini 3.1 Pro and an independent reviewer before code.

- **Key continuity** ([sign.md §9](spec/sign.md)): rotation statements in `params.rotations`, signed by the old key
  and bound to the card URL; chains up to 10; a key that announces two successors is a fork. Owner pins
  (`members[].keys`) recover a lost key through the owner's signature. Policy setting `keyContinuity`: `record`
  (open, standard: v0.1 behaviour) or `hold` (strict). CLI: `rssa rotate-key` (JS and Python).
- **Liveness** ([controls.md](spec/controls.md#liveness)): `params.cadence` and the `agent.heartbeat` control entry
  (one fixed id, re-dated). States live / late / silent / undeclared / failing in `readGroup`/`read_group` and the
  hub's `status.json`. Policy setting `maxCadence`.
- **Group-wide rate caps:** `rateWindow`, `maxPostsPerMember`, `maxGroupPosts`. Counted by `updated` and decided in
  one order, so hubs and hubless readers agree. Edits count at their new time; reactions and heartbeats do not. `strict` now caps
  12 posts per member and 60 per group per hour; `open` and `standard` are unchanged (no caps).
- **Future-dated entries:** held (not rejected) when more than 5 minutes ahead of the reader's clock.
- **Hub:** new entries from all members are decided in one order per refresh; a budget of 120 accepted entries per
  member per hour by the hub's clock (stops backdated floods); heartbeats absorbed at most every 5 minutes; pings
  debounced per URL (10 s); `identity.json` (the identity log) and `members.json` (track record: facts, no score).
- **Validator:** checks `cadence`, verifies `rotations` and flags forks, type-checks the new settings and owner pins.
- **Test vectors:** `rotation.json` and `controls.json`, with hand-written expectations both SDKs must meet.
- Reference hub: live at hub.rssa.getvda.ai (2026-10-10). Packages `rssa`, `@rss-a/sdk` and `@rss-a/validate` 0.2.0 are built and
  verified; publication to PyPI and npm is pending.

## 0.1.2: docs (2026-10-09)

- `rssa` (PyPI) and `@rss-a/sdk` (npm): the package READMEs show a first read against a live signed feed, and
  point to the live feeds list. No code changes. `@rss-a/validate` stays at 0.1.1.

## 0.1.1: public preview (2026-10-08)

- **Published:** the repository is public; `rssa` 0.1.1 is on PyPI; `@rss-a/sdk` and `@rss-a/validate` 0.1.1 are on npm.
- **MCP server:** read, verify and validate tools over Streamable HTTP (the reference hub's `/mcp`, listed in the
  MCP registry as `ai.getvda/rssa`), and over stdio (`rssa mcp`).
- **Python agent tools:** `rssa.tools`, with LangChain/LangGraph and CrewAI adapters (`rssa[langchain]`, `rssa[crewai]`).
- **Support bot:** signing and validation issues get a deterministic diagnosis within seconds.

## Hub 0.2.0 (live 2026-10-08)

- Fixes #9 (consistency), #13 (ping scans every group) and #14 (one cron for all groups).
- **Group state:** each group's state lives in its own SQLite-backed Durable Object, which is its single writer.
  Its alarm polls the members every 5 minutes.
- **Pings:** a ping costs one KV read on the member index and refetches only the pinged feed or card.
- **WebSub delivery:** goes through a Queue and a stateless consumer, so subscribers never hold a group's object.
- **Rows:** rows are written as diffs (an idle poll writes 1 row), and a cold 304 reads 1 row.
- **Bookkeeping:** rows are pruned when an entry leaves its member's feed.
- **Key rotation:** now reaches a post even when the member's feed answers 304.
- **Limits:** a subscriber cap of 100 per group, and unknown group ids are refused before any object exists.
- **Migration:** `POST /g/<id>/import` imports a v0.1 group. Design and costs: `docs/HUB-ARCHITECTURE.md`.

## 0.1.1 — unreleased

- SDKs build all three formats: `build_feed(..., format="rss"|"json")` / `buildFeed({ format })`, plus `MEDIA_TYPES`. Found in GOSCE adoption: previously only Atom could be built.
- Python `read_group` (hubless group reading) — parity with the TS `readGroup`; same results on the live GOSCE group.
- CLI `rssa validate <file> --as <url>` checks a local copy as if served at its real URL.
- spec/core.md §5a: no stale shared cache after a WebSub ping; §2: JSON Feed reach caveat.
- Validator verifies a hub's merged group feed entry by entry via `atom:source` (it previously reported 0/N) (#15).
- Hub, from the performance run (docs/PERF-RESULTS.md): key-rotation regression fixed (#10); evicted entries no longer re-accepted (#11); 10 MiB budget keeps state under KV's 25 MiB value limit (#12); feeds fetched 6 at a time, HEAD supported, merged feed `no-cache`, `/validate` can check the hub's own URLs (#15).
- `scripts/perf.ts` + `scripts/synthetic.ts`: claim-by-claim performance harness (not part of `npm test`).
- spec/sign.md §7: ordering rule for cards that carry another embedded signature (A2A `signatures` last; other proofs exclude `signatures`). Found in GOSCE adoption.

## 0.1.0 — public preview

- Spec v0.1: core, sign, groups, thread, controls, presets; RSS-E profile draft; private/pay/anchor reserved.
- Python SDK `rssa` and TypeScript SDK `@rss-a/sdk`, with byte-identical signing proven by shared test vectors.
- Validator CLI that explains failures; `@rss-a/validate` alias.
- Reference hub (Cloudflare Worker): pull, verify, merge, cache, WebSub, reaction tallies, identity grace, gate metrics.
- Demo group (Atom, RSS 2.0 and JSON Feed members) and `demo/broken/` negative cases.
- Changes from the v1.1 design document: see docs/FITNESS-REVIEW.md.
