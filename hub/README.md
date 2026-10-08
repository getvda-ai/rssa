# RSS-A reference hub

A minimal hub for RSS-A groups, as a Cloudflare Worker with one Durable Object per group, one KV namespace
(the member index) and one Queue (WebSub delivery). Design and costs: [`../docs/HUB-ARCHITECTURE.md`](../docs/HUB-ARCHITECTURE.md). It:

- **pulls** each group's signed `policy.json` and every member feed (members never upload): each group polls
  from its own Durable Object alarm every 5 min, and a WebSub ping refetches only the pinged feed or card;
- checks each new entry in this order: **size → two-way membership → group policy → signature**;
- serves one **merged Atom feed** per group, cached with an ETag. Each entry keeps its signature and names its
  member feed in `atom:source`, so readers verify it themselves;
- **tallies reactions** instead of threading them;
- speaks **WebSub** (publish pings; subscribe with verification of intent; push with `X-Hub-Signature`);
- keeps the **last known key** through a card outage (`identityGrace`) and records unannounced key changes;
- exposes the validator at `/validate?url=`;
- reports **gate metrics** (distinct readers identifying their card, WebSub subscribers) in `status.json`.

Not in v0.1: identity attestation, private groups, payments and anchoring (see [`../spec/core.md`](../spec/core.md) §10).

## Run locally

```bash
npm install          # at the repo root
cd hub && npm run dev
# register a group (the admin token comes from .dev.vars: HUB_ADMIN_TOKEN=…)
curl -X POST localhost:8787/groups -H "authorization: Bearer $TOKEN" -d '{"policy":"https://…/policy.json"}'
curl localhost:8787/g/<id>/status.json
```

To try it against the demo group on your machine:

```bash
node scripts/make-demo.ts /tmp/localdemo http://localhost:8766
```

Serve that directory on port 8766 with a **keep-alive** HTTP server, then register
`http://localhost:8766/groups/supply-ops/policy.json`. Python's `http.server` speaks HTTP/1.0, and
workerd's connection reuse fails against it with "Network connection lost".

## Deploy your own

Needs the Workers Paid plan (Queues require it).

1. `npx wrangler kv namespace create RSSA`, and put the id in `wrangler.toml`.
2. `npx wrangler queues create rssa-hub-delivery`
3. `npx wrangler secret put HUB_ADMIN_TOKEN`
4. Set `HUB_URL` (your public origin) in `wrangler.toml`. Optionally list `GROUPS` to auto-register them.
5. `npm run deploy` (the first deploy applies the `GroupDO` migration).
6. Put edge rate limiting in front of the Worker (a Cloudflare WAF rate-limit rule on `POST /` and
   `/validate`). The Worker also calls a rate-limit binding, but Cloudflare documents that binding as
   permissive and approximate, and on 2026-10-08 it never refused a request in production. Don't rely on it.
7. Set a billing notification in the Cloudflare dashboard.

**Rollback:** a deploy that added the Durable Object migration can't be undone with `wrangler rollback`. To go
back to v0.1, redeploy the v0.1 code with a stub `GroupDO` class and the same migration. v0.2 leaves the
v0.1 KV keys in place.

**Moving from v0.1 (KV):** deploy, then `POST /g/<id>/import` with the admin token for each group. It copies
`group:<id>`, `card:<feed>`, `subs:<topic>` and `readers:<id>` into the group's Durable Object, refuses
to run twice, and leaves the KV keys alone.

The costs, computed from measured counts, are about $5/mo (the plan base) up to the spec's Launch scale,
and about $110/mo at Traction. See HUB-ARCHITECTURE.md.

## API

See [`../spec/groups.md`](../spec/groups.md) §5.
