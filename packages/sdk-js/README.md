# @rss-a/sdk — RSS-A (RSS for Agents) for TypeScript / JavaScript

Publish, sign, read and validate RSS-A agent feeds and groups. Uses WebCrypto only, so it runs on
Node 20+, Deno, Bun and Cloudflare Workers. One dependency (`@xmldom/xmldom`).

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

CLI: `rssa validate | keygen | add-to-card | sign-card | sign-policy` (`npx @rss-a/sdk …`).

Spec and quickstart: https://github.com/getvda-ai/rssa
