// "Is my agent and group policy RSSA-compliant?" — checks that explain their failures.

import { canonicalize, strictParse, utf8 } from "./canonical.ts";
import { EXT_PREFIX, EXT_URI, MODULES, cardModules, findRssa } from "./card.ts";
import { parseFeed, type ParsedFeed } from "./feed.ts";
import { getJson, resolveKeys, signDetached, verifyDetached, type Fetcher, type PublicJwk, type RssaKey } from "./keys.ts";
import {
  CORE_TYPES, PRESETS, REVERSE_DOMAIN, cadenceProblem, durationMs, effectiveSettings, isKnownType, isValidAddress, presetDistance, verifyPolicy,
  type GroupPolicy,
} from "./policy.ts";
import { checkContinuity, type RotationStatement } from "./continuity.ts";
import { verifyEntry } from "./sign.ts";
import { USER_AGENT, keysForFeed } from "./agent.ts";

export type Level = "pass" | "warn" | "fail" | "info";
export interface Finding { level: Level; code: string; message: string; explain?: string; subject?: string }
export interface Report { target: string; kind: "card" | "feed" | "policy" | "unknown"; ok: boolean; findings: Finding[] }

class R {
  findings: Finding[] = [];
  subject?: string;
  constructor(subject?: string) { this.subject = subject; }
  add(level: Level, code: string, message: string, explain?: string) {
    this.findings.push({ level, code, message, ...(explain ? { explain } : {}), ...(this.subject ? { subject: this.subject } : {}) });
  }
  pass(code: string, m: string) { this.add("pass", code, m); }
  warn(code: string, m: string, e?: string) { this.add("warn", code, m, e); }
  fail(code: string, m: string, e?: string) { this.add("fail", code, m, e); }
  info(code: string, m: string, e?: string) { this.add("info", code, m, e); }
}

export interface ValidateOptions { fetcher?: Fetcher; /** Follow links: card → feed → keys → groups → members. Default true. */ deep?: boolean }

const isHttpUrl = (u: unknown): u is string => typeof u === "string" && (/^https:\/\/\S+$/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u));

const CARD_SNIPPET = `"capabilities": { "extensions": [{
    "uri": "${EXT_URI}",
    "description": "RSSA: this agent's feed and modules",
    "required": false,
    "params": { "feed": "https://YOUR-AGENT/rssa/feed.atom" }
}]}`;

// ---------------- Agent Card ----------------

export async function validateCard(card: any, cardUrl: string, o: ValidateOptions = {}): Promise<Finding[]> {
  const r = new R(cardUrl);
  const fetcher = o.fetcher ?? fetch;
  if (!card || typeof card !== "object") { r.fail("card-json", "Agent Card is not a JSON object"); return r.findings; }
  const ext = findRssa(card);
  if (!ext) {
    r.fail("card-extension", "no RSSA extension in capabilities.extensions", `Add this to your Agent Card:\n${CARD_SNIPPET}`);
    return r.findings;
  }
  if (ext.uri !== EXT_URI) r.warn("card-ext-version", `extension uri ${ext.uri}; this validator knows ${EXT_URI}`);
  else r.pass("card-extension", `RSSA extension present (${EXT_URI})`);
  if (ext.required !== false) r.warn("card-required", `set "required": false so agents that don't know RSSA still talk to you`);
  const p = ext.params ?? ({} as any);
  if (!isHttpUrl(p.feed)) { r.fail("card-feed", `params.feed must be an absolute https URL, got ${JSON.stringify(p.feed)}`); return r.findings; }
  r.pass("card-feed", `feed: ${p.feed}`);
  const mods = cardModules(card);
  for (const m of mods) if (!(MODULES as readonly string[]).includes(m) && !REVERSE_DOMAIN.test(m)) r.warn("card-module", `unknown module "${m}" (core modules: ${MODULES.join(", ")}; custom modules use reverse-domain names)`);
  let keys: PublicJwk[] = [];
  if (p.keys) {
    try {
      keys = await resolveKeys(p.keys, fetcher);
      if (keys.length) r.pass("card-keys", `${keys.length} Ed25519 key(s) resolved`);
      else r.fail("card-keys", "params.keys resolved to no Ed25519 keys");
    } catch (e) {
      r.fail("card-keys", `cannot resolve params.keys: ${(e as Error).message}`);
    }
  } else if (mods.includes("sign")) {
    r.fail("card-keys", "the sign module needs params.keys", "Run `rssa keygen` and paste the printed public JWKS into params.keys.");
  }
  if (Array.isArray(card.signatures) && card.signatures.length) {
    const v = keys.length ? await verifyCardSignatures(card, keys) : { ok: false, error: "no RSSA keys to check it with" };
    if (v.ok) r.pass("card-signature", "Agent Card signature (A2A signatures field) verifies with the RSSA keys");
    else r.warn("card-signature", `Agent Card has A2A signatures that do not verify with the RSSA keys: ${v.error}`);
  } else if (mods.includes("sign")) {
    // Card signatures matter once the agent joins groups (standard and strict require them); for broadcast they are optional.
    (p.groups?.length ? r.warn.bind(r) : r.info.bind(r))("card-unsigned", "the Agent Card itself is unsigned (required by standard and strict groups)", "Sign it with `rssa sign-card agent-card.json --key rssa-key.json` (A2A's native signatures field). Re-sign after every card change.");
  }
  for (const g of p.groups ?? []) if (!isHttpUrl(g)) r.fail("card-groups", `params.groups entry ${JSON.stringify(g)} is not an https URL`);
  if (p.hub && !isHttpUrl(p.hub)) r.fail("card-hub", `params.hub ${JSON.stringify(p.hub)} is not an https URL`);
  checkCadence(r, p.cadence);
  await checkRotations(r, p.rotations, cardUrl, keys);
  if (o.deep === false) return r.findings;

  // Feed, checked against what the card promises.
  let feedText: string | undefined;
  try {
    const res = await fetcher(p.feed, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) r.fail("feed-fetch", `GET ${p.feed} returned ${res.status}`);
    else feedText = await res.text();
  } catch (e) {
    r.fail("feed-fetch", `cannot fetch ${p.feed}: ${(e as Error).message}`);
  }
  const findings = [...r.findings];
  if (feedText !== undefined) findings.push(...(await validateFeedText(feedText, p.feed, { card, cardUrl, keys, fetcher })));
  for (const g of p.groups ?? []) {
    const gr = new R(g);
    try {
      const policy = (await getJson(g, fetcher)) as GroupPolicy;
      if (policy.members?.some((m) => m.feed === p.feed)) gr.pass("membership", `group lists this agent's feed (two-way membership holds)`);
      else gr.warn("membership", `this card claims the group, but the group's policy does not list ${p.feed} — not a member until the owner adds it`);
      const req = (policy.requiredModules ?? []).filter((m) => !mods.includes(m));
      if (req.length) gr.fail("required-modules", `the group requires modules ${req.join(", ")} that this card does not declare — the hub will refuse your posts`);
    } catch (e) {
      gr.fail("group-fetch", `cannot fetch group policy: ${(e as Error).message}`);
    }
    findings.push(...gr.findings);
  }
  return findings;
}

/** params.cadence: the agent's promise to show a signal (an entry or a heartbeat) at least this often. */
function checkCadence(r: R, cadence: unknown) {
  if (cadence === undefined) {
    r.info("card-cadence", "no params.cadence: readers cannot tell a quiet agent from a stopped one", 'Declare how often you post or send a heartbeat, e.g. "cadence": "PT1H", and publish an agent.heartbeat entry between posts.');
    return;
  }
  let ms: number;
  try { ms = durationMs(String(cadence)); } catch { r.fail("card-cadence", `params.cadence ${JSON.stringify(cadence)} is not an ISO 8601 duration (e.g. PT1H, P1D)`); return; }
  if (typeof cadence !== "string" || !ms) { r.fail("card-cadence", "params.cadence must be a non-zero ISO 8601 duration string"); return; }
  if (ms < 5 * 60_000) r.warn("card-cadence", `cadence ${cadence} is finer than hubs poll (5 minutes); heartbeats that often only cost writes`);
  else r.pass("card-cadence", `promises a signal at least every ${cadence}`);
}

/** params.rotations: each statement must verify, and no key may announce two successors. */
async function checkRotations(r: R, rotations: unknown, cardUrl: string, keys: PublicJwk[]) {
  if (rotations === undefined) return;
  if (!Array.isArray(rotations)) { r.fail("card-rotations", "params.rotations must be an array of rotation statements"); return; }
  const list = rotations as RotationStatement[];
  const bad = list.filter((x) => !x || typeof x.prev !== "string" || typeof x.next?.x !== "string" || typeof x.sig !== "string" || typeof x.at !== "string");
  if (bad.length) r.fail("card-rotations", `${bad.length} rotation statement(s) are not {prev, next, at, sig}`, "Make them with `rotationStatement` / `rotation_statement` or `rssa rotate-key`.");
  // Without history the validator knows only the card's keys and the keys the statements announce.
  const known = [...keys, ...list.filter((x) => x?.next?.x).map((x) => x.next)];
  const c = await checkContinuity({ cardUrl, trusted: known, current: keys, rotations: list });
  for (const pr of c.problems) r.fail("card-rotations", pr);
  if (!c.problems.length && !bad.length) {
    const verified = c.edges.length;
    const unverifiable = list.length - bad.length - verified;
    if (verified) r.pass("card-rotations", `${verified} rotation statement(s) verify`);
    if (unverifiable) r.info("card-rotations", `${unverifiable} rotation statement(s) are signed by keys the card no longer publishes; only readers that remember those keys can check them`);
  }
}

/** Signs an Agent Card using A2A's native `signatures` field (JWS over the RFC 8785 canonical card). */
export async function signCard(card: any, key: RssaKey): Promise<any> {
  const { signatures: _s, ...body } = card;
  const [protectedB64, , signature] = (await signDetached(utf8(canonicalize(body)), key)).split(".");
  return { ...body, signatures: [{ protected: protectedB64, signature }] };
}

export async function verifyCardSignatures(card: any, keys: PublicJwk[]): Promise<{ ok: boolean; error?: string }> {
  const { signatures, ...body } = card;
  let bytes: Uint8Array;
  try { bytes = utf8(canonicalize(body)); } catch (e) { return { ok: false, error: `card cannot be canonicalised: ${(e as Error).message}` }; }
  let last = "no signatures";
  for (const s of signatures ?? []) {
    const r = await verifyDetached(`${s.protected}..${s.signature}`, bytes, keys);
    if (r.ok) return { ok: true };
    last = r.error ?? last;
  }
  return { ok: false, error: last };
}

// ---------------- Feed ----------------

export async function validateFeedText(
  text: string,
  feedUrl: string,
  ctx: { card?: any; cardUrl?: string; keys?: PublicJwk[]; fetcher?: Fetcher } = {},
): Promise<Finding[]> {
  const r = new R(feedUrl);
  let feed: ParsedFeed;
  try { feed = parseFeed(text); } catch (e) { r.fail("feed-parse", (e as Error).message); return r.findings; }
  r.pass("feed-parse", `${feed.format === "atom" ? "Atom 1.0" : feed.format === "rss" ? "RSS 2.0" : "JSON Feed"} with ${feed.entries.length} readable entries`);
  for (const p of feed.problems) r.fail("entry-core", p, "Core rule: every item needs a unique id and an updated time (Atom id/updated, RSS guid/pubDate, JSON Feed id/date_modified).");
  const seen = new Set<string>();
  for (const e of feed.entries) {
    if (seen.has(e.id)) r.fail("entry-duplicate-id", `duplicate id ${e.id}`, "Ids must be unique within a feed and stable forever; readers dedupe on them.");
    seen.add(e.id);
  }
  const self = feed.selfUrl;
  if (!self) r.warn("feed-self", "no rel=\"self\" link; signed entries bind to the feed URL, so declare it");
  else if (self !== feedUrl) r.warn("feed-self", `rel="self" is ${self} but the feed was fetched from ${feedUrl}`);
  let card = ctx.card;
  if (!card && feed.cardUrl) {
    try { card = await getJson(feed.cardUrl, ctx.fetcher); } catch (e) { r.warn("card-fetch", `cannot read the linked card: ${(e as Error).message}`); }
  }
  const mods = cardModules(card);
  // A hub's merged group feed has no card of its own: each entry names its member feed and card in atom:source.
  const merged = feed.entries.some((e) => e.sourceFeed && e.sourceFeed !== (self ?? feedUrl));
  if (!feed.cardUrl && merged) {
    r.pass("feed-describedby", "merged group feed: each entry carries atom:source and is verified against its member's card");
  } else if (!feed.cardUrl) {
    (mods.includes("sign") ? r.fail.bind(r) : r.warn.bind(r))("feed-describedby", "feed does not link to its Agent Card", `Add <link rel="describedby" href="https://YOUR-AGENT/.well-known/agent-card.json"/> so readers can find your keys.`);
  } else if (ctx.cardUrl && feed.cardUrl !== ctx.cardUrl) {
    r.warn("feed-describedby", `feed links to card ${feed.cardUrl}, but was reached from card ${ctx.cardUrl}`);
  } else {
    r.pass("feed-describedby", `feed links back to its Agent Card`);
  }
  let keys = ctx.keys;
  if (!keys && card) {
    const ext = findRssa(card);
    if (!ext) r.fail("card-extension", `the linked card ${feed.cardUrl} has no RSSA extension`);
    else if (ext.params.feed !== (self ?? feedUrl)) r.fail("card-feed-mismatch", `the card names feed ${ext.params.feed}, not this one — readers will reject the entries`);
    try {
      keys = ext?.params.keys ? await resolveKeys(ext.params.keys, ctx.fetcher) : [];
    } catch (e) {
      r.fail("card-keys", `cannot resolve the card's keys: ${(e as Error).message}`);
    }
  }
  const ids = new Set(feed.entries.map((e) => e.id));
  let signed = 0, verified = 0;
  for (const e of feed.entries) {
    const er = new R(`${feedUrl} ${e.id}`);
    if (e.type && !isKnownType(e.type)) er.warn("entry-type", `type ${e.type} is neither core (${CORE_TYPES.join(", ")}) nor reverse-domain`);
    if (e.to && !isValidAddress(e.to)) er.warn("entry-to", `rssa:to ${JSON.stringify(e.to)} should be "group", "role:<name>", an https URL or a DID`);
    if (e.summary && [...e.summary.trim()].length > 280) er.warn("entry-summary", `summary is ${[...e.summary.trim()].length} characters; standard and strict groups allow 280`);
    if (!e.summary) er.info("entry-summary", "no <summary>; standard and strict groups require one so agents can skip without spending tokens");
    if (e.type === "reaction" && !e.inReplyTo) er.fail("entry-reaction", "reaction without thr:in-reply-to — reactions must point at their target");
    if (e.inReplyTo && !ids.has(e.inReplyTo)) er.info("entry-thread", `replies to ${e.inReplyTo}, which is not in this feed (fine if it's another agent's entry)`);
    if (e.sig || e.payload) {
      signed++;
      const fromMember = e.sourceFeed && e.sourceFeed !== (self ?? feedUrl);
      const k = fromMember ? await keysForFeed(e.sourceFeed!, e.sourceCard, ctx.fetcher ?? fetch) : keys ?? [];
      const v = await verifyEntry(e, e.sourceFeed ?? self ?? feedUrl, k);
      for (const c of v.checks) if (!c.ok) er.fail(`sign-${c.code}`, c.message, c.explain);
      else if (c.code === "payload-not-canonical") er.info(c.code, c.message, c.explain);
      if (v.ok) verified++;
    } else if (mods.includes("sign")) {
      er.fail("sign-unsigned", "entry is unsigned but the card declares the sign module", "Sign entries with buildFeed({..., key}) or rssa.build_feed(..., key=key).");
    }
    r.findings.push(...er.findings);
  }
  if (signed) (verified === signed ? r.pass.bind(r) : r.fail.bind(r))("sign-summary", `${verified}/${signed} signed entries verify`);
  return r.findings;
}

// ---------------- Group policy ----------------

const KNOWN_POLICY_FIELDS = new Set(["version", "group", "name", "owner", "members", "preset", "overrides", "requiredModules", "hub", "sig", "description", "residency"]);

export async function validatePolicyText(text: string, policyUrl: string, o: ValidateOptions = {}): Promise<Finding[]> {
  const r = new R(policyUrl);
  const fetcher = o.fetcher ?? fetch;
  let p: GroupPolicy;
  try { p = strictParse(text) as any; } catch (e) { r.fail("policy-json", `policy is not signable JSON: ${(e as Error).message}`, "Policies are signed like entries: strings, booleans and integers only."); return r.findings; }
  if (!Number.isInteger(p.version) || p.version < 1) r.fail("policy-version", "version must be an integer ≥ 1, incremented on every change");
  if (!isHttpUrl(p.group)) r.fail("policy-group", "group must be the https URL of this policy.json");
  else if (p.group !== policyUrl && /^https?:/.test(policyUrl)) r.warn("policy-group", `group is ${p.group} but the policy was fetched from ${policyUrl}`);
  if (typeof p.owner !== "string") r.fail("policy-owner", "owner must be a key reference: did:web:…, an https JWKS URL or an Agent Card URL");
  if (!Array.isArray(p.members)) r.fail("policy-members", "members must be an array of { feed, role? }");
  const preset = p.preset ?? "standard";
  if (!(preset in PRESETS)) r.fail("policy-preset", `preset ${preset} must be open, standard or strict`);
  if (!p.preset) r.info("policy-preset", "no preset given; hubs apply standard");
  for (const k of Object.keys(p)) if (!KNOWN_POLICY_FIELDS.has(k) && !REVERSE_DOMAIN.test(k)) r.warn("policy-field", `unknown field "${k}"; custom fields must use a reverse-domain name (com.example.${k})`);
  for (const k of Object.keys(p.overrides ?? {})) if (!(k in PRESETS.standard) && !REVERSE_DOMAIN.test(k)) r.warn("policy-override", `unknown setting "${k}"; custom settings must use a reverse-domain name`);
  for (const m of p.requiredModules ?? []) if (!(MODULES as readonly string[]).includes(m) && !REVERSE_DOMAIN.test(m)) r.warn("policy-module", `unknown required module ${m}`);
  const o2 = (p.overrides ?? {}) as Record<string, unknown>;
  for (const k of ["maxPostsPerMember", "maxGroupPosts"]) if (k in o2 && !(Number.isInteger(o2[k]) && (o2[k] as number) >= 0)) r.fail("policy-override", `${k} must be an integer ≥ 0 (0 = unlimited)`);
  for (const k of ["rateWindow", "maxCadence"]) {
    if (!(k in o2) || (k === "maxCadence" && o2[k] === "")) continue;
    try { if (!durationMs(String(o2[k]))) throw new Error(); } catch { r.fail("policy-override", `${k} must be a non-zero ISO 8601 duration (e.g. PT1H)`); }
  }
  if ("keyContinuity" in o2 && !["record", "hold"].includes(o2.keyContinuity as string)) r.fail("policy-override", "keyContinuity must be record or hold");
  for (const m of Array.isArray(p.members) ? p.members : []) {
    if (m.keys !== undefined && !(Array.isArray(m.keys) && m.keys.every((x) => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x)))) {
      r.fail("policy-member", `member ${m.feed} keys must be RFC 7638 thumbprints (43 base64url characters), the owner's pins`);
    }
  }
  if (r.findings.some((f) => f.level === "fail")) return r.findings;
  const s = effectiveSettings(p);
  if (s.hub === "required" && !isHttpUrl(p.hub)) r.fail("policy-hub", `preset ${preset} requires a hub; set "hub"`);
  const seen = new Set<string>();
  for (const m of p.members) {
    if (!isHttpUrl(m.feed)) r.fail("policy-member", `member feed ${JSON.stringify(m.feed)} is not an https URL`);
    if (seen.has(m.feed)) r.fail("policy-member", `member ${m.feed} is listed twice`);
    seen.add(m.feed);
  }
  const v = await verifyPolicy(p, fetcher);
  if (v.ok) r.pass("policy-signature", `policy signed by owner (kid ${v.kid})`);
  else (preset === "open" ? r.warn.bind(r) : r.fail.bind(r))("policy-signature", `policy signature: ${v.error}`, "Sign it with `rssa sign-policy policy.json --key owner-key.json`.");
  const dist = presetDistance(p);
  if (!dist.length) r.pass("policy-preset", `uses preset ${preset} unchanged`);
  for (const d of dist) r.info("policy-override", `${d.setting}: ${JSON.stringify(d.preset)} → ${JSON.stringify(d.value)}${d.relaxes ? " (relaxes the preset)" : " (stricter)"}`);
  const rsse = preset === "strict" && !dist.some((d) => d.relaxes);
  r.info("rss-e", rsse ? "preset is RSS-E compatible (strict, no relaxing overrides); full RSS-E needs anchoring and identity checks too" : "not RSS-E (needs preset strict with no relaxing overrides)");
  if (s.anchoring === "required") r.warn("policy-anchoring", "anchoring is required but the anchor module is not in v0.1; reference hubs cannot enforce it yet");
  if (o.deep === false) return r.findings;
  for (const m of p.members) {
    const mr = new R(m.feed);
    try {
      const res = await fetcher(m.feed, { headers: { "user-agent": USER_AGENT } });
      if (!res.ok) { mr.fail("member-fetch", `GET returned ${res.status}`); r.findings.push(...mr.findings); continue; }
      const feed = parseFeed(await res.text());
      if (!feed.cardUrl) { mr.fail("member-card", "member feed has no rel=describedby link to its Agent Card, so membership cannot be confirmed"); r.findings.push(...mr.findings); continue; }
      const card = await getJson(feed.cardUrl, fetcher);
      const ext = findRssa(card);
      const groups: string[] = ext?.params.groups ?? [];
      if (ext?.params.feed !== m.feed) mr.fail("member-card", `member's card names feed ${ext?.params.feed}, not ${m.feed}`);
      else if (groups.includes(p.group)) mr.pass("membership", "two-way membership holds");
      else mr.fail("membership", "member's Agent Card does not list this group in params.groups — it has not agreed to join", `The member adds "${p.group}" to params.groups in its card.`);
      const mods = cardModules(card);
      const missing = (p.requiredModules ?? []).filter((x) => !mods.includes(x));
      if (missing.length) mr.fail("required-modules", `member does not declare required modules ${missing.join(", ")}`);
      const cp = cadenceProblem((ext?.params as any)?.cadence, s);
      if (cp) mr.fail("member-cadence", cp);
    } catch (e) {
      mr.fail("member-fetch", (e as Error).message);
    }
    r.findings.push(...mr.findings);
  }
  return r.findings;
}

// ---------------- Entry point ----------------

/** Validates a URL or raw text, detecting whether it is an Agent Card, a feed or a group policy. */
export async function validate(target: string, o: ValidateOptions & { text?: string } = {}): Promise<Report> {
  const fetcher = o.fetcher ?? fetch;
  let text = o.text;
  let url = target;
  if (text === undefined) {
    let res = await fetcher(url, { headers: { "user-agent": USER_AGENT, accept: "application/json, application/atom+xml, */*" } });
    // A bare origin means "find my Agent Card".
    if (/^https?:\/\/[^/]+\/?$/.test(url)) {
      for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
        const u = url.replace(/\/$/, "") + path;
        const r2 = await fetcher(u, { headers: { "user-agent": USER_AGENT } }).catch(() => undefined);
        if (r2?.ok) { res = r2; url = u; break; }
      }
    }
    if (!res.ok) return { target, kind: "unknown", ok: false, findings: [{ level: "fail", code: "fetch", message: `GET ${url} returned ${res.status}` }] };
    text = await res.text();
  }
  const t = text.trimStart();
  let kind: Report["kind"] = "unknown";
  let findings: Finding[];
  if (t.startsWith("{")) {
    let j: any;
    try { j = JSON.parse(t); } catch (e) { return { target, kind, ok: false, findings: [{ level: "fail", code: "json", message: `not valid JSON: ${(e as Error).message}` }] }; }
    if (j.capabilities || j.skills || j.protocolVersion) { kind = "card"; findings = await validateCard(j, url, o); }
    else if (Array.isArray(j.members) || j.owner) { kind = "policy"; findings = await validatePolicyText(t, url, o); }
    else { kind = "feed"; findings = await validateFeedText(t, url, { fetcher }); }
  } else {
    kind = "feed";
    findings = await validateFeedText(t, url, { fetcher });
  }
  return { target: url, kind, ok: !findings.some((f) => f.level === "fail"), findings };
}

export function formatReport(r: Report, verbose = false): string {
  const icon: Record<Level, string> = { pass: "✔", warn: "⚠", fail: "✖", info: "·" };
  const lines = [`RSSA validation of ${r.kind}: ${r.target}`];
  let subject: string | undefined;
  for (const f of r.findings) {
    if (!verbose && f.level === "info") continue;
    if (f.subject && f.subject !== subject) { subject = f.subject; lines.push(`  ${subject}`); }
    lines.push(`    ${icon[f.level]} ${f.message}`);
    if (f.explain && f.level !== "pass") lines.push(...f.explain.split("\n").map((l) => `        ${l}`));
  }
  const n = (l: Level) => r.findings.filter((f) => f.level === l).length;
  lines.push("", r.ok ? `PASS — ${n("pass")} checks passed, ${n("warn")} warnings` : `FAIL — ${n("fail")} failures, ${n("warn")} warnings`);
  return lines.join("\n");
}
