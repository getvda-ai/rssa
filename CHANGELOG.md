# Changelog

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
