// Support bot for this repo's issues (.github/workflows/validate-issue.yml; entry point issue-validate.ts).
//
// Deterministic, no LLM: it runs the same checks as the SDK and the validator and explains what they found.
// It answers when an issue
//   - has a line `validate: https://…` (or the `validate` label), or
//   - is about signing or validation (signature, verify, validate, canonical, JCS, payload…) AND contains
//     something to check: a JSON or XML code block, or an https URL.
// For pasted JSON it reports the exact problem the canonical rules reject (floats, duplicate keys, unsafe
// integers, lone surrogates) with the JSON path and the fix. It recognises Agent Cards, group policies,
// entries (and their base64url payloads) and raw payloads, and runs the matching validator. Pasted feeds
// (Atom, RSS, JSON Feed) are validated too. Nothing from the issue is executed.

import {
  CanonicalError, canonicalize, formatReport, strictParse, validate, validateCard, validateFeedText, validatePolicyText,
  type Finding, type Fetcher,
} from "../packages/sdk-js/src/index.ts";

export const MARKER = "<!-- rssa-bot -->";
const TOPIC = /\b(signatures?|sign(ed|ing)?|verif(y|ies|ied|ication)|validat(e|or|ion|ing)|canonical(i[sz]e|ization)?|jcs|payload|content-?hash|rssa)\b/i;
const URL_RE = /https:\/\/[^\s<>"'`)\]]+/;

export function targetFrom(body: string, labels: string[] = []): string | undefined {
  const explicit = /^\s*validate:\s*(https:\/\/[^\s<>"'`)\]]+)/im.exec(body)?.[1];
  if (explicit) return explicit;
  if (labels.includes("validate")) return URL_RE.exec(body)?.[0];
  return undefined;
}

export interface Block { lang: string; text: string }

export function codeBlocks(body: string): Block[] {
  const out: Block[] = [];
  const re = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
  for (let m = re.exec(body); m && out.length < 4; m = re.exec(body)) out.push({ lang: m[1].toLowerCase(), text: m[2].trim() });
  return out.filter((b) => b.text.length > 0 && b.text.length <= 200_000);
}

const CANON_FIX: Record<string, string> = {
  float: 'RSS-A signs integers only, because languages disagree on how to print decimals (`12.5`, `12.50` and `1.25e1` are the same number). Send amounts and measurements as strings, e.g. `"12.50"`. Don\'t build payloads by hand: `signEntry` / `sign_entry` produce them.',
  "duplicate-key": "The same key appears twice in one object. Parsers disagree on which value wins, so signed JSON rejects it. Remove the duplicate.",
  "unsafe-integer": "Integers must be within ±(2^53−1) so JavaScript and Python read the same value. Send larger numbers as strings.",
  "lone-surrogate": "A string contains half of a UTF-16 surrogate pair, which has no UTF-8 encoding. Fix the text encoding at the source.",
  syntax: "This isn't valid JSON. Check quotes, commas and brackets around the offset shown.",
  type: "This value type can't be signed (only strings, booleans, integers, null, arrays and objects can).",
};

function b64urlDecode(s: string): string | undefined {
  try {
    const b = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
  } catch { return undefined; }
}

function findingsMd(f: Finding[]): string {
  const icon = { pass: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" } as const;
  return f.filter((x) => x.level !== "info" || f.length < 12)
    .map((x) => `- ${icon[x.level]} \`${x.code}\` ${x.message}${x.explain && x.level !== "pass" ? `\n  ${x.explain}` : ""}`).join("\n");
}

/** One plain sentence per canonical error: what and where. The fix follows separately (CANON_FIX). */
function canonProblem(e: CanonicalError): string {
  const where = `\`${e.path ?? "$"}\``;
  const lit = /(?:number|integer) (\S+)/.exec(e.message)?.[1];
  const key = /duplicate key ("[^"]*")/.exec(e.message)?.[1];
  const detail = e.message.replace(/ at offset \d+ \(at [^)]*\)$/, "").replace(/ \(at [^)]*\)$/, "");
  switch (e.code) {
    case "float": return `**\`float\`**: ${where} is \`${lit ?? "a decimal number"}\`, which isn't an integer.`;
    case "unsafe-integer": return `**\`unsafe-integer\`**: ${where} is \`${lit ?? "a large integer"}\`, outside ±(2^53−1).`;
    case "duplicate-key": return `**\`duplicate-key\`**: the object at ${where} has the key ${key ? `\`${key}\`` : ""} twice.`;
    case "lone-surrogate": return `**\`lone-surrogate\`**: a string at ${where} contains half a surrogate pair.`;
    case "syntax": return `**\`syntax\`**: ${detail} (${/offset \d+/.exec(e.message)?.[0] ?? "position unknown"}).`;
    default: return `**\`${e.code}\`** at ${where}: ${detail}.`;
  }
}

function canonicalSection(label: string, text: string): { md: string; parsed?: unknown; ok: boolean } {
  try {
    const parsed = strictParse(text);
    canonicalize(parsed);
    return { md: `✅ ${label} is valid signable JSON (no floats, duplicate keys or unsafe integers).`, parsed, ok: true };
  } catch (e) {
    if (e instanceof CanonicalError) {
      return { md: `❌ ${label}: ${canonProblem(e)}\n\n${CANON_FIX[e.code] ?? ""}`, ok: false };
    }
    return { md: `❌ ${label}: ${(e as Error).message}`, ok: false };
  }
}

/** Diagnoses one pasted block. Returns markdown, or undefined if the block isn't something we can check. */
export async function diagnoseBlock(b: Block, fetcher?: Fetcher): Promise<string | undefined> {
  const t = b.text;
  if (/^(<\?xml|<feed[\s>]|<rss[\s>])/i.test(t) || b.lang === "xml") {
    const self = /<(?:atom:)?link[^>]*rel=["']self["'][^>]*href=["']([^"']+)/i.exec(t)?.[1] ?? /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']self["']/i.exec(t)?.[1];
    const f = await validateFeedText(t, self ?? "https://unknown.invalid/feed", { fetcher });
    return `**Pasted feed**${self ? ` (rel=self ${self})` : " (no rel=self link, so signatures can't be bound to a URL)"}\n\n${findingsMd(f)}`;
  }
  if (!/^[[{]/.test(t)) return undefined;
  const c = canonicalSection("The pasted JSON", t);
  if (!c.ok) return `**Pasted JSON**\n\n${c.md}`;
  const j = c.parsed as Record<string, any>;
  if (j && typeof j === "object" && !Array.isArray(j)) {
    if (Array.isArray(j.members) && (j.group || j.owner)) {
      return `**Pasted group policy**\n\n${findingsMd(await validatePolicyText(t, typeof j.group === "string" ? j.group : "https://unknown.invalid/policy.json", { fetcher }))}`;
    }
    if (j.capabilities || j.skills || j.protocolVersion) {
      return `**Pasted Agent Card**\n\n${findingsMd(await validateCard(j, typeof j.url === "string" ? j.url : "https://unknown.invalid/card.json", { fetcher, deep: false }))}`;
    }
    if (typeof j.payload === "string" && j.id) {
      const decoded = b64urlDecode(j.payload);
      if (decoded === undefined) return `**Pasted entry** \`${j.id}\`\n\n❌ \`payload\` isn't base64url-encoded UTF-8 JSON. It must be the base64url of the canonical payload bytes.`;
      const pc = canonicalSection("Its decoded payload", decoded);
      let extra = "";
      if (pc.ok) {
        const p = pc.parsed as Record<string, unknown>;
        const canon = canonicalize(p);
        extra = canon === decoded
          ? "\n\nThe payload bytes are already canonical (RFC 8785), as they must be."
          : `\n\n❌ The payload bytes are **not canonical**. Signers must sign exactly the RFC 8785 form:\n\`\`\`\n${canon.slice(0, 2000)}\n\`\`\``;
        const missing = ["id", "updated", "feed", "contentHash"].filter((k) => !(k in p));
        if (missing.length) extra += `\n\n❌ Required payload fields missing: ${missing.map((m) => `\`${m}\``).join(", ")} (spec/sign.md §3).`;
        if (p.id !== undefined && p.id !== j.id) extra += `\n\n❌ The payload's \`id\` (${JSON.stringify(p.id)}) differs from the entry's id (${JSON.stringify(j.id)}).`;
      }
      return `**Pasted entry** \`${j.id}\`\n\n${pc.md}${extra}\n\nTo check the signature itself, the bot needs the feed URL: add a line \`validate: https://…/your-feed\` to the issue.`;
    }
    if ("contentHash" in j && "feed" in j) {
      const canon = canonicalize(j);
      return `**Pasted payload**\n\n${c.md}\n\nIts canonical (RFC 8785) form, which is exactly what gets signed:\n\`\`\`\n${canon.slice(0, 2000)}\n\`\`\``;
    }
  }
  return `**Pasted JSON**\n\n${c.md}`;
}

export interface BotInput { body: string; labels?: string[]; title?: string }

/** Decides whether to answer, and builds the comment. Returns undefined when the issue isn't for the bot. */
export async function respond(input: BotInput, fetcher?: Fetcher): Promise<string | undefined> {
  const body = input.body ?? "";
  const labels = input.labels ?? [];
  const explicit = targetFrom(body, labels);
  const onTopic = TOPIC.test(`${input.title ?? ""}\n${body}`);
  const blocks = codeBlocks(body);
  const url = explicit ?? (onTopic ? URL_RE.exec(body.replace(/```[\s\S]*?```/g, ""))?.[0] : undefined);
  if (!explicit && !(onTopic && (blocks.length || url))) return undefined;

  const parts: string[] = [];
  for (const b of blocks) {
    const d = await diagnoseBlock(b, fetcher);
    if (d) parts.push(d);
  }
  if (url) {
    const r = await validate(url, { fetcher });
    const report = formatReport(r, true).replace(/```/g, "ʼʼʼ").slice(0, 40_000);
    parts.push(`**\`${url}\`**: ${r.ok ? "✅ PASS" : `❌ FAIL (${r.findings.filter((f) => f.level === "fail").length} failing check(s))`}\n\n<details${r.ok ? "" : " open"}><summary>Validator report (${r.kind})</summary>\n\n\`\`\`\n${report}\n\`\`\`\n</details>`);
  }
  if (!parts.length) return undefined;
  const failed = parts.some((p) => p.includes("❌"));
  const head = failed
    ? "I ran the RSS-A checks on what you posted. Each problem below has the reason and the fix."
    : "I ran the RSS-A checks on what you posted and found no problems.";
  return `${MARKER}\n${head}\n\n${parts.join("\n\n---\n\n")}\n\n` +
    `<sub>Automated and deterministic: the same checks as \`npx @rss-a/sdk validate\` and the SDKs' canonical JSON rules. ` +
    `Edit the issue to re-run (this comment updates in place). A maintainer will follow up if this doesn't answer your question.</sub>\n`;
}

/** Backwards-compatible single-URL report (used by tests and by `validate:` issues). */
export async function comment(url: string, fetcher?: Fetcher): Promise<string> {
  return (await respond({ body: `validate: ${url}` }, fetcher))!;
}
