// Parse Atom 1.0, RSS 2.0 and JSON Feed 1.1 into one entry model, and build Atom.
// Readers ignore anything they don't recognise (must-ignore).

import { DOMParser, type Element as XElement } from "@xmldom/xmldom";

export const NS = {
  atom: "http://www.w3.org/2005/Atom",
  thr: "http://purl.org/syndication/thread/1.0",
  rssa: "https://rssa.getvda.ai/ns/0.1",
  content: "http://purl.org/rss/1.0/modules/content/",
} as const;

export interface RssaEntry {
  id: string;
  /** RFC 3339 instant. For RSS 2.0, converted from atom:updated or pubDate. */
  updated: string;
  title?: string;
  summary?: string;
  content?: string;
  /** Atom content type: "text" | "html" | "xhtml" | a media type. */
  contentType?: string;
  link?: string;
  type?: string;
  to?: string;
  source?: string;
  inReplyTo?: string;
  reaction?: string;
  /** The signed payload exactly as carried (JSON text). */
  payload?: string;
  /** Detached compact JWS over the canonical payload. */
  sig?: string;
  /** In merged (hub) feeds: the member feed this entry came from (atom:source). */
  sourceFeed?: string;
  sourceCard?: string;
}

export interface ParsedFeed {
  format: "atom" | "rss" | "json";
  title?: string;
  selfUrl?: string;
  /** rel="describedby": the publisher's Agent Card. */
  cardUrl?: string;
  hubUrl?: string;
  entries: RssaEntry[];
  /** Entries that could not be read (missing id or date), with the reason. */
  problems: string[];
}

const text = (el: XElement | null | undefined) => (el ? (el.textContent ?? "") : undefined);

function children(el: XElement, ns: string, local: string): XElement[] {
  const out: XElement[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as XElement).namespaceURI === ns && (n as XElement).localName === local) out.push(n as XElement);
  }
  return out;
}
const child = (el: XElement, ns: string, local: string) => children(el, ns, local)[0];
const childNoNs = (el: XElement, local: string) => {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && !(n as XElement).namespaceURI && (n as XElement).localName === local) return n as XElement;
  }
  return undefined;
};

function links(el: XElement): { rel: string; href: string }[] {
  return children(el, NS.atom, "link").map((l) => ({ rel: l.getAttribute("rel") || "alternate", href: l.getAttribute("href") || "" }));
}

function rfc3339(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const ms = Date.parse(d.trim());
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

function rssaFields(el: XElement): Partial<RssaEntry> {
  const f: Partial<RssaEntry> = {};
  const get = (local: string) => {
    const e = child(el, NS.rssa, local);
    return e ? (e.textContent ?? "").trim() : undefined;
  };
  for (const k of ["type", "to", "source", "reaction", "payload", "sig"] as const) {
    const v = get(k);
    if (v !== undefined) f[k] = v;
  }
  const irt = child(el, NS.thr, "in-reply-to");
  if (irt) f.inReplyTo = irt.getAttribute("ref") ?? undefined;
  return f;
}

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function parseFeed(body: string): ParsedFeed {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return parseJsonFeed(JSON.parse(trimmed));
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level: string, msg: string) => { if (level !== "warning") errors.push(msg); },
  } as any).parseFromString(body, "text/xml");
  const root = doc.documentElement;
  if (!root || errors.length) throw new Error(`not well-formed XML: ${errors[0] ?? "no root element"}`);
  if (root.namespaceURI === NS.atom && root.localName === "feed") return parseAtom(root);
  if (root.localName === "rss") return parseRss(root);
  throw new Error(`unrecognised feed root <${root.localName}> — expected Atom <feed>, RSS <rss> or a JSON Feed`);
}

function parseAtom(feed: XElement): ParsedFeed {
  const ls = links(feed);
  const out: ParsedFeed = {
    format: "atom",
    title: text(child(feed, NS.atom, "title"))?.trim(),
    selfUrl: ls.find((l) => l.rel === "self")?.href,
    cardUrl: ls.find((l) => l.rel === "describedby")?.href,
    hubUrl: ls.find((l) => l.rel === "hub")?.href,
    entries: [],
    problems: [],
  };
  for (const e of children(feed, NS.atom, "entry")) {
    const id = text(child(e, NS.atom, "id"))?.trim();
    const updatedRaw = text(child(e, NS.atom, "updated"))?.trim();
    const updated = rfc3339(updatedRaw);
    if (!id || !updated) {
      out.problems.push(`entry ${id ?? "(no id)"}: ${!id ? "missing <id>" : `missing or unparseable <updated> "${updatedRaw ?? ""}"`}`);
      continue;
    }
    const c = child(e, NS.atom, "content");
    const src = child(e, NS.atom, "source");
    const el = links(e);
    out.entries.push(strip({
      id,
      updated,
      title: text(child(e, NS.atom, "title")),
      summary: text(child(e, NS.atom, "summary")),
      content: text(c),
      contentType: c ? (c.getAttribute("type") || "text") : undefined,
      link: el.find((l) => l.rel === "alternate")?.href,
      ...rssaFields(e),
      sourceFeed: src ? links(src).find((l) => l.rel === "self")?.href : undefined,
      sourceCard: src ? links(src).find((l) => l.rel === "describedby")?.href : undefined,
    }));
  }
  return out;
}

function parseRss(rss: XElement): ParsedFeed {
  const channel = childNoNs(rss, "channel");
  if (!channel) throw new Error("RSS feed has no <channel>");
  const ls = links(channel);
  const out: ParsedFeed = {
    format: "rss",
    title: text(childNoNs(channel, "title"))?.trim(),
    selfUrl: ls.find((l) => l.rel === "self")?.href,
    cardUrl: ls.find((l) => l.rel === "describedby")?.href,
    hubUrl: ls.find((l) => l.rel === "hub")?.href,
    entries: [],
    problems: [],
  };
  for (let n = channel.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1 || (n as XElement).namespaceURI || (n as XElement).localName !== "item") continue;
    const it = n as XElement;
    const id = text(childNoNs(it, "guid"))?.trim();
    const updatedRaw = text(child(it, NS.atom, "updated"))?.trim() ?? text(childNoNs(it, "pubDate"))?.trim();
    const updated = rfc3339(updatedRaw);
    if (!id || !updated) {
      out.problems.push(`item ${id ?? "(no guid)"}: ${!id ? "missing <guid>" : `missing or unparseable <pubDate> "${updatedRaw ?? ""}"`}`);
      continue;
    }
    const encoded = child(it, NS.content, "encoded");
    out.entries.push(strip({
      id,
      updated,
      title: text(childNoNs(it, "title")),
      summary: text(childNoNs(it, "description")),
      content: text(encoded),
      contentType: encoded ? "html" : undefined,
      link: text(childNoNs(it, "link"))?.trim(),
      ...rssaFields(it),
    }));
  }
  return out;
}

function parseJsonFeed(j: any): ParsedFeed {
  if (typeof j.version !== "string" || !j.version.startsWith("https://jsonfeed.org/version/")) throw new Error("JSON is not a JSON Feed (missing version)");
  const out: ParsedFeed = {
    format: "json",
    title: j.title,
    selfUrl: j.feed_url,
    cardUrl: j._rssa?.card,
    hubUrl: (j.hubs ?? []).find((h: any) => String(h.type).toLowerCase() === "websub")?.url,
    entries: [],
    problems: [],
  };
  for (const it of j.items ?? []) {
    const id = it.id != null ? String(it.id) : undefined;
    const updated = rfc3339(it.date_modified ?? it.date_published);
    if (!id || !updated) {
      out.problems.push(`item ${id ?? "(no id)"}: ${!id ? "missing id" : "missing date_modified/date_published"}`);
      continue;
    }
    const r = it._rssa ?? {};
    out.entries.push(strip({
      id,
      updated,
      title: it.title,
      summary: it.summary,
      content: it.content_text ?? it.content_html,
      contentType: it.content_text != null ? "text" : it.content_html != null ? "html" : undefined,
      link: it.url,
      type: r.type,
      to: r.to,
      source: r.source,
      inReplyTo: r.inReplyTo,
      reaction: r.reaction,
      payload: typeof r.payload === "string" ? r.payload : r.payload != null ? JSON.stringify(r.payload) : undefined,
      sig: r.sig,
    }));
  }
  return out;
}

// ---------- building ----------

/** Escapes for attribute values. */
export const esc = (s: string) => escText(s).replace(/"/g, "&quot;");
/** Escapes for text content (quotes stay readable, which keeps rssa:payload legible). */
export const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface FeedMeta {
  /** Canonical URL of this feed (atom:link rel=self). Signed entries bind to it. */
  feedUrl: string;
  /** URL of the Agent Card (atom:link rel=describedby). */
  cardUrl?: string;
  title: string;
  hubUrl?: string;
  /** Feed id; defaults to feedUrl. */
  id?: string;
  author?: string;
}

/** Serialises entries as an Atom 1.0 feed with the rssa and thr namespaces. */
export function atomXml(meta: FeedMeta, entries: RssaEntry[]): string {
  const updated = entries.reduce((m, e) => (e.updated > m ? e.updated : m), "1970-01-01T00:00:00Z");
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<feed xmlns="${NS.atom}" xmlns:rssa="${NS.rssa}" xmlns:thr="${NS.thr}">`,
    `  <id>${escText(meta.id ?? meta.feedUrl)}</id>`,
    `  <title>${escText(meta.title)}</title>`,
    `  <updated>${updated}</updated>`,
    `  <link rel="self" href="${esc(meta.feedUrl)}"/>`,
  ];
  if (meta.cardUrl) lines.push(`  <link rel="describedby" type="application/json" href="${esc(meta.cardUrl)}"/>`);
  if (meta.hubUrl) lines.push(`  <link rel="hub" href="${esc(meta.hubUrl)}"/>`);
  lines.push(`  <author><name>${escText(meta.author ?? meta.title)}</name></author>`);
  for (const e of entries) lines.push(entryXml(e, "  "));
  lines.push(`</feed>`, ``);
  return lines.join("\n");
}

export function entryXml(e: RssaEntry, ind = ""): string {
  const i2 = ind + "  ";
  const l = [`${ind}<entry>`, `${i2}<id>${escText(e.id)}</id>`, `${i2}<updated>${e.updated}</updated>`, `${i2}<title>${escText(e.title ?? e.summary?.slice(0, 80) ?? e.type ?? e.id)}</title>`];
  if (e.link) l.push(`${i2}<link rel="alternate" href="${esc(e.link)}"/>`);
  if (e.summary !== undefined) l.push(`${i2}<summary>${escText(e.summary)}</summary>`);
  if (e.content !== undefined) l.push(`${i2}<content type="${esc(e.contentType && e.contentType !== "xhtml" ? e.contentType : "text")}">${escText(e.content)}</content>`);
  if (e.inReplyTo) l.push(`${i2}<thr:in-reply-to ref="${esc(e.inReplyTo)}"/>`);
  for (const k of ["type", "to", "source", "reaction"] as const) if (e[k] !== undefined) l.push(`${i2}<rssa:${k}>${escText(e[k]!)}</rssa:${k}>`);
  if (e.payload) l.push(`${i2}<rssa:payload>${escText(e.payload)}</rssa:payload>`);
  if (e.sig) l.push(`${i2}<rssa:sig>${escText(e.sig)}</rssa:sig>`);
  if (e.sourceFeed) {
    l.push(`${i2}<source>`, `${i2}  <id>${escText(e.sourceFeed)}</id>`, `${i2}  <link rel="self" href="${esc(e.sourceFeed)}"/>`);
    if (e.sourceCard) l.push(`${i2}  <link rel="describedby" href="${esc(e.sourceCard)}"/>`);
    l.push(`${i2}</source>`);
  }
  l.push(`${ind}</entry>`);
  return l.join("\n");
}

/** RSS 2.0 with the atom, content, thr and rssa namespaces. Items carry atom:updated (the exact
 *  instant, so edits are expressible) as well as pubDate. */
export function rssXml(meta: FeedMeta & { link?: string; description?: string }, entries: RssaEntry[]): string {
  const l = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<rss version="2.0" xmlns:atom="${NS.atom}" xmlns:content="${NS.content}" xmlns:thr="${NS.thr}" xmlns:rssa="${NS.rssa}">`,
    `  <channel>`,
    `    <title>${escText(meta.title)}</title>`,
    `    <link>${escText(meta.link ?? meta.feedUrl)}</link>`,
    `    <description>${escText(meta.description ?? meta.title)}</description>`,
    `    <atom:link rel="self" href="${esc(meta.feedUrl)}"/>`,
  ];
  if (meta.cardUrl) l.push(`    <atom:link rel="describedby" href="${esc(meta.cardUrl)}"/>`);
  if (meta.hubUrl) l.push(`    <atom:link rel="hub" href="${esc(meta.hubUrl)}"/>`);
  for (const e of entries) {
    l.push(`    <item>`, `      <guid isPermaLink="false">${escText(e.id)}</guid>`, `      <pubDate>${new Date(e.updated).toUTCString()}</pubDate>`, `      <atom:updated>${e.updated}</atom:updated>`);
    if (e.title !== undefined) l.push(`      <title>${escText(e.title)}</title>`);
    if (e.link) l.push(`      <link>${escText(e.link)}</link>`);
    if (e.summary !== undefined) l.push(`      <description>${escText(e.summary)}</description>`);
    if (e.content !== undefined) l.push(`      <content:encoded>${escText(e.content)}</content:encoded>`);
    if (e.inReplyTo) l.push(`      <thr:in-reply-to ref="${esc(e.inReplyTo)}"/>`);
    for (const k of ["type", "to", "source", "reaction", "payload", "sig"] as const) if (e[k]) l.push(`      <rssa:${k}>${escText(e[k]!)}</rssa:${k}>`);
    l.push(`    </item>`);
  }
  l.push(`  </channel>`, `</rss>`, ``);
  return l.join("\n");
}

/** JSON Feed 1.1 with the `_rssa` extension (feed-level card link, per-item fields). */
export function jsonFeed(meta: FeedMeta & { homePageUrl?: string }, entries: RssaEntry[]): string {
  const doc: Record<string, unknown> = { version: "https://jsonfeed.org/version/1.1", title: meta.title, feed_url: meta.feedUrl };
  if (meta.homePageUrl) doc.home_page_url = meta.homePageUrl;
  if (meta.hubUrl) doc.hubs = [{ type: "WebSub", url: meta.hubUrl }];
  if (meta.cardUrl) doc._rssa = { card: meta.cardUrl };
  doc.items = entries.map((e) => {
    const it: Record<string, unknown> = { id: e.id, date_modified: e.updated };
    if (e.title !== undefined) it.title = e.title;
    if (e.summary !== undefined) it.summary = e.summary;
    if (e.link !== undefined) it.url = e.link;
    if (e.content !== undefined) it[e.contentType === "html" ? "content_html" : "content_text"] = e.content;
    const r = Object.fromEntries((["type", "to", "source", "inReplyTo", "reaction", "payload", "sig"] as const).filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
    if (Object.keys(r).length) it._rssa = r;
    return it;
  });
  return JSON.stringify(doc, null, 2) + "\n";
}
