// The one Agent Card line: an A2A extension under capabilities.extensions.

import type { Jwks } from "./keys.ts";
import type { RotationStatement } from "./continuity.ts";

export const EXT_URI = "https://rssa.getvda.ai/ext/v0.1";
export const EXT_PREFIX = "https://rssa.getvda.ai/ext/";
export const MODULES = ["sign", "groups", "thread", "controls", "private", "pay", "anchor"] as const;

export interface RssaParams {
  /** The only required param: this agent's feed URL. */
  feed: string;
  modules?: string[];
  hub?: string;
  /** Policy URLs of groups this agent belongs to (the agent's half of two-way membership). */
  groups?: string[];
  /** Inline JWKS, an https URL to a JWKS, or a did:web. Required by the sign module. */
  keys?: Jwks | string;
  /** Key rotation statements, newest first, each signed by the key it replaces (sign.md §9). */
  rotations?: RotationStatement[];
  /** ISO 8601 duration: this agent shows a signal (an entry or a heartbeat) at least this often. */
  cadence?: string;
}

export interface RssaExtension {
  uri: string;
  description: string;
  required: false;
  params: RssaParams;
}

export function cardExtension(params: RssaParams): RssaExtension {
  const p: RssaParams = { feed: params.feed };
  if (params.modules?.length) p.modules = params.modules;
  if (params.hub) p.hub = params.hub;
  if (params.groups?.length) p.groups = params.groups;
  if (params.keys) p.keys = params.keys;
  if (params.rotations?.length) p.rotations = params.rotations;
  if (params.cadence) p.cadence = params.cadence;
  return { uri: EXT_URI, description: "RSSA: this agent's feed and modules", required: false, params: p };
}

/** Adds (or replaces) the RSSA extension in an Agent Card object, returning a new card. */
export function withRssa<T extends Record<string, any>>(card: T, params: RssaParams): T {
  const caps = { ...(card.capabilities ?? {}) };
  const exts = (caps.extensions ?? []).filter((e: any) => !String(e?.uri ?? "").startsWith(EXT_PREFIX));
  caps.extensions = [...exts, cardExtension(params)];
  return { ...card, capabilities: caps };
}

export function findRssa(card: any): RssaExtension | undefined {
  return (card?.capabilities?.extensions ?? []).find((e: any) => typeof e?.uri === "string" && e.uri.startsWith(EXT_PREFIX));
}

/** Modules listed in the card, without version suffixes ("sign@0.1" → "sign"). */
export function cardModules(card: any): string[] {
  return (findRssa(card)?.params?.modules ?? []).map((m: string) => String(m).split("@")[0]);
}
