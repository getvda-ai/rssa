// The groups and controls modules: one signed policy.json per group, presets, checks.

import { canonicalize, strictParse, utf8 } from "./canonical.ts";
import type { RssaEntry } from "./feed.ts";
import { esc } from "./feed.ts";
import { resolveKeys, signDetached, verifyDetached, type Fetcher, type RssaKey } from "./keys.ts";

export const CORE_TYPES = [
  "brief.published", "exception.reported", "question.asked", "answer.posted",
  "decision.recorded", "reaction", "group.joined", "group.left",
] as const;
export const CORE_REACTIONS = ["agree", "disagree", "ack"] as const;

/** Custom types and reactions use a reverse-domain prefix with at least three labels: com.example.supply.delay */
export const REVERSE_DOMAIN = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2,}$/;

export interface Settings {
  signatures: "optional" | "required";
  summary: "optional" | "required";
  /** Max summary length in characters; 0 = unlimited. */
  summaryMaxLength: number;
  addressing: "optional" | "required";
  /** Max reply depth; 0 = unlimited. */
  maxDepth: number;
  /** ISO 8601 duration between posts by one agent in one thread. */
  minInterval: string;
  contentFreeReplies: "allowed" | "reactions-only";
  allowedTypes: "any" | "core+declared" | "declared";
  declaredTypes: string[];
  membership: "open" | "owner-approves";
  anchoring: "none" | "optional" | "required";
  hub: "optional" | "required";
  identityGrace: string;
}

export const PRESETS: Record<"open" | "standard" | "strict", Settings> = {
  open: {
    signatures: "optional", summary: "optional", summaryMaxLength: 0, addressing: "optional", maxDepth: 0, minInterval: "PT0S",
    contentFreeReplies: "allowed", allowedTypes: "any", declaredTypes: [], membership: "open", anchoring: "none", hub: "optional", identityGrace: "PT24H",
  },
  standard: {
    signatures: "required", summary: "required", summaryMaxLength: 280, addressing: "optional", maxDepth: 8, minInterval: "PT1M",
    contentFreeReplies: "reactions-only", allowedTypes: "core+declared", declaredTypes: [], membership: "owner-approves", anchoring: "optional", hub: "required", identityGrace: "PT24H",
  },
  strict: {
    signatures: "required", summary: "required", summaryMaxLength: 280, addressing: "required", maxDepth: 4, minInterval: "PT15M",
    contentFreeReplies: "reactions-only", allowedTypes: "declared", declaredTypes: [], membership: "owner-approves", anchoring: "required", hub: "required", identityGrace: "PT24H",
  },
};

export interface Member { feed: string; role?: string; name?: string }

export interface GroupPolicy {
  version: number;
  /** Canonical URL of this policy.json — the group's identity. */
  group: string;
  name?: string;
  /** Key reference of the owner: did:web, https JWKS URL or Agent Card URL. */
  owner: string;
  members: Member[];
  preset?: "open" | "standard" | "strict";
  overrides?: Partial<Settings> & Record<string, unknown>;
  requiredModules?: string[];
  hub?: string;
  sig?: string;
  [k: string]: unknown;
}

export function effectiveSettings(p: Pick<GroupPolicy, "preset" | "overrides">): Settings {
  const base = PRESETS[p.preset ?? "standard"] ?? PRESETS.standard;
  const o = Object.fromEntries(Object.entries(p.overrides ?? {}).filter(([k]) => k in base));
  return { ...base, ...o } as Settings;
}

/** ISO 8601 duration (days/hours/minutes/seconds) to milliseconds. */
export function durationMs(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m || d === "P" || d.endsWith("T")) throw new Error(`bad ISO 8601 duration ${d} (use e.g. PT5M, PT1H, P1D)`);
  return (((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)) * 60 + +(m[4] ?? 0)) * 1000;
}

const unsigned = (p: GroupPolicy) => {
  const { sig: _sig, ...rest } = p;
  return rest;
};

export async function signPolicy(p: GroupPolicy, key: RssaKey): Promise<GroupPolicy> {
  const body = unsigned(p);
  return { ...body, sig: await signDetached(utf8(canonicalize(body)), key) };
}

/** Parses policy JSON strictly (floats and duplicate keys are rejected, as for any signed payload). */
export function parsePolicy(text: string): GroupPolicy {
  return strictParse(text) as unknown as GroupPolicy;
}

export async function verifyPolicy(p: GroupPolicy, fetcher?: Fetcher): Promise<{ ok: boolean; error?: string; kid?: string }> {
  if (!p.sig) return { ok: false, error: "policy is unsigned (no sig field)" };
  let keys;
  try { keys = await resolveKeys(p.owner, fetcher); } catch (e) { return { ok: false, error: `cannot resolve owner keys ${p.owner}: ${(e as Error).message}` }; }
  const r = await verifyDetached(p.sig, utf8(canonicalize(unsigned(p))), keys);
  return r.ok ? { ok: true, kid: r.kid } : { ok: false, error: r.error };
}

const ORDER: Record<string, string[]> = {
  signatures: ["optional", "required"],
  summary: ["optional", "required"],
  addressing: ["optional", "required"],
  contentFreeReplies: ["allowed", "reactions-only"],
  allowedTypes: ["any", "core+declared", "declared"],
  membership: ["open", "owner-approves"],
  anchoring: ["none", "optional", "required"],
  hub: ["optional", "required"],
};

/** How a policy departs from its preset: each override, and whether it relaxes the preset. */
export function presetDistance(p: GroupPolicy): { setting: string; preset: unknown; value: unknown; relaxes: boolean }[] {
  const base: any = PRESETS[p.preset ?? "standard"];
  const out = [];
  for (const [k, v] of Object.entries(p.overrides ?? {})) {
    if (!(k in base)) continue;
    const b = base[k];
    let relaxes = false;
    if (ORDER[k]) relaxes = ORDER[k].indexOf(v as string) < ORDER[k].indexOf(b);
    else if (k === "maxDepth" || k === "summaryMaxLength") relaxes = (v === 0 && b !== 0) || (b !== 0 && (v as number) > b);
    else if (k === "minInterval") relaxes = durationMs(v as string) < durationMs(b);
    else if (k === "identityGrace") relaxes = durationMs(v as string) > durationMs(b);
    if (JSON.stringify(v) !== JSON.stringify(b)) out.push({ setting: k, preset: b, value: v, relaxes });
  }
  return out;
}

export function isKnownType(t: string) {
  return (CORE_TYPES as readonly string[]).includes(t) || REVERSE_DOMAIN.test(t);
}

export function isValidAddress(to: string) {
  return to === "group" || /^role:[A-Za-z0-9._-]+$/.test(to) || /^https:\/\/\S+$/.test(to) || /^did:[a-z0-9]+:\S+$/.test(to);
}

export interface ThreadContext {
  /** Depth of a known entry in this group (root = 0), or undefined if unknown. */
  depthOf(id: string): number | undefined;
  /** Root id of the thread containing a known entry. */
  rootOf(id: string): string | undefined;
  /** Time (ms) of this feed's previous post in the given thread, if any. */
  lastPost(feed: string, root: string): number | undefined;
}

export interface Violation { code: string; message: string }

/**
 * Checks one entry against the group's effective settings. Signatures and membership are
 * checked elsewhere (cheap structural checks first, crypto last); this is the policy step.
 */
export function checkEntry(e: RssaEntry, feed: string, s: Settings, ctx?: ThreadContext): Violation[] {
  const v: Violation[] = [];
  const add = (code: string, message: string) => v.push({ code, message });
  if (s.summary === "required" && e.type !== "reaction" && !e.summary?.trim()) add("summary-required", "this group requires a <summary> on every entry");
  if (s.summaryMaxLength && e.summary && [...e.summary.trim()].length > s.summaryMaxLength) {
    add("summary-too-long", `summary is ${[...e.summary.trim()].length} characters; this group allows ${s.summaryMaxLength}`);
  }
  if (s.addressing === "required" && !e.to) add("addressing-required", "this group requires rssa:to (group, role:<name> or an agent URL)");
  if (e.to && !isValidAddress(e.to)) add("bad-address", `rssa:to ${JSON.stringify(e.to)} must be "group", "role:<name>", an https URL or a DID`);
  if (e.type) {
    if (!isKnownType(e.type)) add("unknown-type", `type ${e.type} is neither a core type nor reverse-domain (com.example.thing)`);
    else if (s.allowedTypes === "declared" && !s.declaredTypes.includes(e.type)) add("type-not-declared", `type ${e.type} is not in this group's declaredTypes`);
    else if (s.allowedTypes === "core+declared" && !(CORE_TYPES as readonly string[]).includes(e.type) && !s.declaredTypes.includes(e.type)) {
      add("type-not-declared", `custom type ${e.type} must be listed in this group's declaredTypes`);
    }
  } else if (s.allowedTypes !== "any") {
    add("type-required", "this group requires rssa:type on every entry");
  }
  if (e.type === "reaction") {
    if (!e.inReplyTo) add("reaction-target", "a reaction must point at its target with thr:in-reply-to");
    if (!e.reaction) add("reaction-value", "a reaction needs rssa:reaction (agree, disagree, ack or reverse-domain)");
    else if (!(CORE_REACTIONS as readonly string[]).includes(e.reaction) && !REVERSE_DOMAIN.test(e.reaction)) add("reaction-value", `unknown reaction ${e.reaction}`);
  } else if (e.inReplyTo && s.contentFreeReplies === "reactions-only") {
    if (!e.type) add("content-free-reply", "replies must be typed; to agree, disagree or acknowledge, post a reaction instead");
    else if (!(e.content?.trim() || e.source)) add("content-free-reply", "a reply needs content or rssa:source; use a reaction for agreement");
  }
  if (ctx && e.inReplyTo && e.type !== "reaction") {
    const parent = ctx.depthOf(e.inReplyTo);
    const depth = (parent ?? 0) + 1;
    if (s.maxDepth && depth > s.maxDepth) add("too-deep", `reply depth ${depth} exceeds this group's maxDepth ${s.maxDepth}`);
    const root = ctx.rootOf(e.inReplyTo) ?? e.inReplyTo;
    const last = ctx.lastPost(feed, root);
    const gap = durationMs(s.minInterval);
    if (gap && last !== undefined && Date.parse(e.updated) - last < gap) {
      add("too-fast", `posted ${Math.round((Date.parse(e.updated) - last) / 1000)}s after this agent's previous post in the thread; minInterval is ${s.minInterval}`);
    }
  }
  return v;
}

/** The unsigned OPML 2.0 convenience export. RSSA agents never trust it for membership. */
export function rosterOpml(p: GroupPolicy): string {
  const title = p.name ?? p.group;
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<!-- Generated from ${esc(p.group)} (version ${p.version}). Membership is defined by the signed policy, not this file. -->`,
    `<opml version="2.0">`,
    `  <head><title>${esc(title)}</title></head>`,
    `  <body>`,
    ...p.members.map((m) => `    <outline type="rss" text="${esc(m.name ?? m.feed)}" xmlUrl="${esc(m.feed)}"${m.role ? ` category="${esc(m.role)}"` : ""}/>`),
    `  </body>`,
    `</opml>`,
    ``,
  ];
  return lines.join("\n");
}
