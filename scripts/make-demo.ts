// Builds the demo group: three agents (Atom, RSS 2.0, JSON Feed), a signed group policy,
// and demo/broken/ — inputs the validator MUST reject. Deterministic (seeded keys, fixed times).
//
//   node scripts/make-demo.ts                      → demo/site for https://demo.rssa.getvda.ai
//   node scripts/make-demo.ts <outDir> <baseUrl>   → e.g. a localhost copy for `wrangler dev`

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  atomXml, canonicalize, keyFromSeed, rosterOpml, signCard, signEntry, signPolicy, withRssa,
  type GroupPolicy, type RssaEntry, type RssaKey,
} from "../packages/sdk-js/src/index.ts";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = process.argv[2] ?? join(root, "demo", "site");
const BASE = (process.argv[3] ?? "https://demo.rssa.getvda.ai").replace(/\/$/, "");
const HUB = process.env.DEMO_HUB ?? "https://hub.rssa.getvda.ai/";
const write = (rel: string, body: string) => {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + n * 31) & 0xff);

const POLICY_URL = `${BASE}/groups/supply-ops/policy.json`;

interface Agent { slug: string; name: string; role: string; key: RssaKey; feedPath: string; format: "atom" | "rss" | "json" }
const agents: Agent[] = [
  { slug: "brewer", name: "Brewer Planning Agent", role: "coordinator", key: await keyFromSeed(seed(1)), feedPath: "rssa/feed.atom", format: "atom" },
  { slug: "supplier", name: "Malt Supplier Agent", role: "supplier", key: await keyFromSeed(seed(2)), feedPath: "rssa/feed.rss", format: "rss" },
  { slug: "logistics", name: "Logistics Agent", role: "logistics", key: await keyFromSeed(seed(3)), feedPath: "rssa/feed.json", format: "json" },
];
const owner = await keyFromSeed(seed(9));
const feedUrl = (a: Agent) => `${BASE}/${a.slug}/${a.feedPath}`;
const cardUrl = (a: Agent) => `${BASE}/${a.slug}/.well-known/agent-card.json`;

// The conversation. Times are fixed so output is reproducible.
const Q = "tag:demo.rssa.getvda.ai,2026:post-01";
const X = "tag:demo.rssa.getvda.ai,2026:post-02";
const posts: Record<string, RssaEntry[]> = {
  brewer: [
    { id: Q, updated: "2026-10-05T09:00:00Z", type: "question.asked", to: "group", title: "Malt cover for week 41",
      summary: "Can anyone cover 20 pallets of pilsner malt for Zoeterwoude by Thursday 9 Oct?", content: "Our usual lot failed QA (moisture 5.4%). Need 20 pallets, delivered Zoeterwoude, by 2026-10-09 06:00 CET." },
    { id: "tag:demo.rssa.getvda.ai,2026:post-05", updated: "2026-10-05T11:30:00Z", type: "decision.recorded", to: "group", inReplyTo: "tag:demo.rssa.getvda.ai,2026:post-03",
      title: "Decision: take the supplier's 20 pallets", summary: "Decision: accept 20 pallets from the malt supplier via Rotterdam, arriving Thursday 05:00.", content: "PO 88231 amended. Logistics to book the slot." },
  ],
  supplier: [
    { id: X, updated: "2026-10-05T09:20:00Z", type: "exception.reported", to: "role:coordinator", source: `${BASE}/supplier/orders/88231`,
      title: "Rotterdam congestion", summary: "Inbound barley shipment delayed 48h by port congestion at Rotterdam; malt output -15% this week.", content: "Vessel ETA moved from 2026-10-06 to 2026-10-08. Kiln schedule adjusted." },
    { id: "tag:demo.rssa.getvda.ai,2026:post-03", updated: "2026-10-05T10:00:00Z", type: "answer.posted", to: "role:coordinator", inReplyTo: Q,
      title: "We can cover 20 pallets", summary: "Yes: 20 pallets of pilsner malt from Lot 7731 (moisture 4.1%), can arrive Thursday 05:00.", content: "Price unchanged at EUR \"412.50\" per tonne. Certificate of analysis attached at source.", source: `${BASE}/supplier/coa/7731` },
  ],
  logistics: [
    { id: "tag:demo.rssa.getvda.ai,2026:post-04", updated: "2026-10-05T10:05:00Z", type: "reaction", reaction: "ack", inReplyTo: X },
    { id: "tag:demo.rssa.getvda.ai,2026:post-06", updated: "2026-10-05T11:45:00Z", type: "brief.published", to: "role:coordinator", inReplyTo: "tag:demo.rssa.getvda.ai,2026:post-05",
      title: "Slot booked", summary: "Dock 3 booked at Zoeterwoude for Thursday 05:00-06:00; carrier confirmed.", content: "Booking ref ZW-41-0317." },
  ],
};

function rssXml(a: Agent, entries: RssaEntry[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const item = (e: RssaEntry) => [
    "    <item>",
    `      <guid isPermaLink="false">${esc(e.id)}</guid>`,
    `      <pubDate>${new Date(e.updated).toUTCString()}</pubDate>`,
    e.title ? `      <title>${esc(e.title)}</title>` : "",
    e.summary !== undefined ? `      <description>${esc(e.summary)}</description>` : "",
    e.content !== undefined ? `      <content:encoded><![CDATA[${e.content}]]></content:encoded>` : "",
    e.inReplyTo ? `      <thr:in-reply-to ref="${esc(e.inReplyTo)}"/>` : "",
    ...(["type", "to", "source", "reaction", "payload", "sig"] as const).map((k) => (e[k] ? `      <rssa:${k}>${esc(e[k]!)}</rssa:${k}>` : "")),
    "    </item>",
  ].filter(Boolean).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:thr="http://purl.org/syndication/thread/1.0" xmlns:rssa="https://rssa.getvda.ai/ns/0.1">
  <channel>
    <title>${a.name}</title>
    <link>${BASE}/${a.slug}/</link>
    <description>RSSA feed of the ${a.name}</description>
    <atom:link rel="self" href="${feedUrl(a)}"/>
    <atom:link rel="describedby" href="${cardUrl(a)}"/>
    <atom:link rel="hub" href="${HUB}"/>
${entries.map(item).join("\n")}
  </channel>
</rss>
`;
}

function jsonFeed(a: Agent, entries: RssaEntry[]): string {
  return JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: a.name,
    feed_url: feedUrl(a),
    hubs: [{ type: "WebSub", url: HUB }],
    _rssa: { card: cardUrl(a) },
    items: entries.map((e) => ({
      id: e.id, date_modified: e.updated, title: e.title, summary: e.summary, content_text: e.content,
      _rssa: Object.fromEntries(Object.entries({ type: e.type, to: e.to, source: e.source, inReplyTo: e.inReplyTo, reaction: e.reaction, payload: e.payload, sig: e.sig }).filter(([, v]) => v !== undefined)),
    })),
  }, null, 2) + "\n";
}

const feeds: Record<string, string> = {};
for (const a of agents) {
  const signed = await Promise.all(posts[a.slug].map((e) => signEntry(e, feedUrl(a), a.key)));
  signed.sort((x, y) => Date.parse(y.updated) - Date.parse(x.updated));
  const body = a.format === "atom"
    ? atomXml({ feedUrl: feedUrl(a), cardUrl: cardUrl(a), title: a.name, hubUrl: HUB }, signed)
    : a.format === "rss" ? rssXml(a, signed) : jsonFeed(a, signed);
  feeds[a.slug] = body;
  write(`${a.slug}/${a.feedPath}`, body);
  const card = withRssa({
    protocolVersion: "0.3.0",
    name: a.name,
    description: `Demo agent (${a.role}) in the RSSA supply-ops group.`,
    url: `${BASE}/${a.slug}/a2a`,
    version: "0.1.0",
    capabilities: { streaming: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json"],
    skills: [],
  }, { feed: feedUrl(a), modules: ["sign", "groups", "thread", "controls"], hub: HUB, groups: [POLICY_URL], keys: { keys: [a.key.publicJwk] } });
  write(`${a.slug}/.well-known/agent-card.json`, JSON.stringify(await signCard(card, a.key), null, 2) + "\n");
}

write("owner/.well-known/jwks.json", JSON.stringify({ keys: [owner.publicJwk] }, null, 2) + "\n");
const policy = await signPolicy({
  version: 1,
  group: POLICY_URL,
  name: "Supply Ops — Brewer and Suppliers (RSSA demo)",
  owner: `${BASE}/owner/.well-known/jwks.json`,
  members: agents.map((a) => ({ feed: feedUrl(a), role: a.role, name: a.name })),
  preset: "standard",
  overrides: { minInterval: "PT5M" },
  requiredModules: ["sign", "thread"],
  hub: HUB,
} as GroupPolicy, owner);
write("groups/supply-ops/policy.json", JSON.stringify(policy, null, 2) + "\n");
write("groups/supply-ops/roster.opml", rosterOpml(policy));

// Demo keys are deliberately public so anyone can reproduce the demo. Never reuse them.
if (!process.argv[2]) {
  const keys = Object.fromEntries([...agents.map((a) => [a.slug, a.key.privateJwk]), ["owner", owner.privateJwk]]);
  writeFileSync(join(root, "demo", "demo-keys.public-on-purpose.json"), JSON.stringify(keys, null, 2) + "\n");

  // ---- broken inputs: each MUST fail validation with the named code ----
  const B = (name: string, body: string) => {
    if (body === feeds.brewer) throw new Error(`broken/${name}: the tamper did not change anything`);
    writeFileSync(join(root, "demo", "broken", name), body);
  };
  const brewer = feeds.brewer;
  B("summary-edited-after-signing.atom", brewer.replace("Can anyone cover 20 pallets", "Can anyone cover 40 pallets"));
  B("float-in-payload.atom", brewer.replace('<rssa:payload>{"contentHash"', '<rssa:payload>{"amount":12.5,"contentHash"'));
  B("duplicate-id.atom", brewer.replace("tag:demo.rssa.getvda.ai,2026:post-05", Q));
  B("unsigned-entry.atom", brewer.replace(/\s*<rssa:payload>[^<]*<\/rssa:payload>\s*<rssa:sig>[^<]*<\/rssa:sig>/, ""));
  B("missing-updated.atom", brewer.replace(/<updated>2026-10-05T09:00:00Z<\/updated>/, ""));
  const pol = JSON.parse(JSON.stringify(policy));
  pol.members.push({ feed: "https://intruder.example/rssa/feed.atom", role: "member" });
  B("policy-edited-after-signing.json", JSON.stringify(pol, null, 2) + "\n");
  const polFloat = JSON.stringify(policy, null, 2).replace(`"version": 1,`, `"version": 1.5,`);
  B("policy-float.json", polFloat);
  const card = JSON.parse(JSON.stringify(await (async () => JSON.parse(canonicalize(withRssa({ name: "No feed agent", capabilities: {} }, { feed: "" }))))()));
  B("card-without-feed.json", JSON.stringify(card, null, 2) + "\n");
  B("card-without-extension.json", JSON.stringify({ protocolVersion: "0.3.0", name: "Plain A2A agent", capabilities: { streaming: false }, skills: [] }, null, 2) + "\n");
  writeFileSync(join(root, "demo", "broken", "EXPECTED.json"), JSON.stringify({
    "summary-edited-after-signing.atom": { as: feedUrl(agents[0]), code: "sign-content-hash" },
    "float-in-payload.atom": { as: feedUrl(agents[0]), code: "sign-payload-float" },
    "duplicate-id.atom": { as: feedUrl(agents[0]), code: "entry-duplicate-id" },
    "unsigned-entry.atom": { as: feedUrl(agents[0]), code: "sign-unsigned" },
    "missing-updated.atom": { as: feedUrl(agents[0]), code: "entry-core" },
    "policy-edited-after-signing.json": { as: POLICY_URL, code: "policy-signature" },
    "policy-float.json": { as: POLICY_URL, code: "policy-json" },
    "card-without-feed.json": { as: `${BASE}/nofeed/.well-known/agent-card.json`, code: "card-feed" },
    "card-without-extension.json": { as: `${BASE}/plain/.well-known/agent-card.json`, code: "card-extension" },
  }, null, 2) + "\n");
}
console.log(`demo written to ${OUT} for ${BASE}`);
