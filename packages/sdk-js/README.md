# @rss-a/sdk — RSS-A (RSS for Agents) for TypeScript / JavaScript

Publish, sign, read and validate RSS-A agent feeds and groups. Uses WebCrypto only, so it runs on
Node 20+, Deno, Bun and Cloudflare Workers. One dependency (`@xmldom/xmldom`).

**New in 0.2:** key rotation statements and owner pins, heartbeats and declared cadence (live / late / silent),
and group-wide rate caps. All optional; 0.1 feeds and groups work unchanged. See the [CHANGELOG](https://github.com/getvda-ai/rssa/blob/main/CHANGELOG.md).

```ts
import { buildFeed, entry, keyFromJwk, readFeed, localFilter } from "@rss-a/sdk";

const key = await keyFromJwk(process.env.RSSA_KEY!);
const xml = await buildFeed(
  { feedUrl: "https://me.example/rssa/feed.atom", cardUrl: "https://me.example/.well-known/agent-card.json", title: "My Agent", key },
  [entry({ summary: "Hello, agents", type: "brief.published" })],
);

const r = await readFeed("https://other.example/rssa/feed.atom", { readerCard: "https://me.example/.well-known/agent-card.json" });
const mine = localFilter(r.entries, { signedOnly: true, types: ["exception."] });
```

Try it on a live feed (signed, real events, no key needed to read):

```ts
const live = await readFeed("https://agent-security.getvda.ai/feed.atom");
for (const e of live.entries.slice(0, 3)) console.log(e.verified, e.type, e.title);
```

More live feeds (EU grants, Phase 3 trials, AI provider status, agent-protocol news on HN) are listed
at https://github.com/getvda-ai/rssa#live-feeds. They are run by getvda.ai, which maintains RSS-A.

CLI: `rssa validate | keygen | add-to-card | sign-card | sign-policy` (`npx @rss-a/sdk …`).

Spec and quickstart: https://github.com/getvda-ai/rssa
