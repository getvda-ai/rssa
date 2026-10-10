#!/usr/bin/env node
// rssa — validate agents, feeds and groups; generate keys; sign cards and policies.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { findRssa, withRssa } from "./card.ts";
import { rotationStatement } from "./continuity.ts";
import { generateKey, keyFromJwk, thumbprint, type Jwks, type PublicJwk } from "./keys.ts";
import { parsePolicy, rosterOpml, signPolicy } from "./policy.ts";
import { formatReport, signCard, validate } from "./validate.ts";
import { createInterface } from "node:readline";
import { handleMcpMessage, type JsonRpc, type McpOptions } from "./mcp.ts";

const HELP = `rssa — RSS for Agents

  rssa validate <url | file> [--as <url>] [--json] [--verbose] [--shallow]
      Checks an Agent Card, feed or group policy. Given a card it follows the whole
      chain: card → feed → keys → signatures → groups. Given a bare origin
      (https://agent.example.com) it finds the card under /.well-known/. With a file,
      --as <url> checks it as if served there (signatures bind to the feed URL).

  rssa keygen [--out rssa-key.json]
      Creates an Ed25519 key. Writes the PRIVATE key to --out (keep it secret, e.g. in a
      secret manager) and prints the public JWKS to paste into your card's params.keys.

  rssa add-to-card <card.json> --feed <feed-url> [--key rssa-key.json] [--modules sign,thread]
      Adds the RSSA extension line to an existing Agent Card file, in place.

  rssa sign-card <card.json> --key <key.json>      Signs the card (A2A native signatures field), in place.
  rssa sign-policy <policy.json> --key <key.json>  Signs a group policy in place, and writes roster.opml beside it.

  rssa rotate-key <card.json> --key <old-key.json> --new <new-key.json> --card-url <url> [--drop-old]
      Announces a new key: adds a rotation statement signed by the old key to params.rotations,
      adds the new public key to params.keys, and re-signs the card with the new key. The old
      public key stays in params.keys (so entries it signed still verify) unless --drop-old.

  rssa mcp [--reader-card <your card URL>]
      Runs an MCP server on stdio with tools to read, verify and filter agent feeds and
      groups, and to validate. For Claude Desktop, Cursor, CrewAI, LangGraph and other MCP clients.
`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const cmd = args[0];

async function loadKey(path: string | undefined) {
  if (!path) throw new Error("--key <file> is required");
  return keyFromJwk(readFileSync(path, "utf8"));
}

async function main() {
  if (!cmd || cmd === "help" || has("help")) { console.log(HELP); return; }
  if (cmd === "validate" || cmd === "doctor") {
    const target = args[1];
    if (!target) throw new Error("usage: rssa validate <url | file>");
    const isUrl = /^https?:\/\//.test(target);
    // --as <url>: check a local file as if it were served at that URL (signatures bind to the
    // feed URL, so a draft or a suspect copy can only be checked against its real address).
    const as = flag("as");
    const report = isUrl
      ? await validate(target, { deep: !has("shallow") })
      : await validate(as ?? target, { deep: !has("shallow"), text: readFileSync(target, "utf8") });
    console.log(has("json") ? JSON.stringify(report, null, 2) : formatReport(report, has("verbose")));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (cmd === "mcp") {
    await serveMcpStdio({ readerCard: flag("reader-card") });
    return;
  }
  if (cmd === "keygen") {
    const out = flag("out") ?? "rssa-key.json";
    if (existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite a key`);
    const k = await generateKey();
    writeFileSync(out, JSON.stringify(k.privateJwk, null, 2) + "\n", { mode: 0o600 });
    console.error(`Private key written to ${out} — keep it secret (never commit it; load it from a secret at runtime).`);
    console.error(`Paste this into your Agent Card's RSSA params as "keys":`);
    console.log(JSON.stringify({ keys: [k.publicJwk] }, null, 2));
    return;
  }
  if (cmd === "add-to-card") {
    const file = args[1];
    const feed = flag("feed");
    if (!file || !feed) throw new Error("usage: rssa add-to-card <card.json> --feed <feed-url>");
    const card = JSON.parse(readFileSync(file, "utf8"));
    const key = flag("key") ? await loadKey(flag("key")) : undefined;
    const modules = flag("modules")?.split(",").filter(Boolean) ?? (key ? ["sign"] : undefined);
    const prev = (card.capabilities?.extensions ?? []).find((e: any) => String(e?.uri).startsWith("https://rssa.getvda.ai/ext/"))?.params ?? {};
    const next = withRssa(card, { ...prev, feed, ...(modules ? { modules } : {}), ...(key ? { keys: { keys: [key.publicJwk] } } : {}) });
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    console.log(`Added the RSSA extension to ${file}. Next: publish your feed at ${feed}, then run: rssa validate <your card URL>`);
    return;
  }
  if (cmd === "sign-card") {
    const file = args[1];
    const signed = await signCard(JSON.parse(readFileSync(file, "utf8")), await loadKey(flag("key")));
    writeFileSync(file, JSON.stringify(signed, null, 2) + "\n");
    console.log(`Signed ${file}. Re-sign after every change to the card.`);
    return;
  }
  if (cmd === "sign-policy") {
    const file = args[1];
    const signed = await signPolicy(parsePolicy(readFileSync(file, "utf8")), await loadKey(flag("key")));
    writeFileSync(file, JSON.stringify(signed, null, 2) + "\n");
    const opml = file.replace(/[^/\\]*$/, "roster.opml");
    writeFileSync(opml, rosterOpml(signed));
    console.log(`Signed ${file} (version ${signed.version}) and wrote ${opml}. Bump "version" on every change.`);
    return;
  }
  if (cmd === "rotate-key") {
    const file = args[1];
    const cardUrl = flag("card-url");
    if (!file || !cardUrl || !flag("new")) throw new Error("usage: rssa rotate-key <card.json> --key <old-key.json> --new <new-key.json> --card-url <url>");
    const [old, next] = [await loadKey(flag("key")), await loadKey(flag("new"))];
    const card = JSON.parse(readFileSync(file, "utf8"));
    const params = findRssa(card)?.params;
    if (!params) throw new Error(`${file} has no RSSA extension; run add-to-card first`);
    const published: PublicJwk[] = params.keys && typeof params.keys === "object" ? (params.keys as Jwks).keys : [];
    if (!published.some((k) => k.x === old.publicJwk.x)) throw new Error("--key is not one of the card's published keys; a statement from it would not be trusted");
    const st = await rotationStatement(cardUrl, old, next.publicJwk);
    const keys = [...(has("drop-old") ? published.filter((k) => k.x !== old.publicJwk.x) : published), next.publicJwk].filter((k, i, a) => a.findIndex((y) => y.x === k.x) === i);
    const updated = withRssa(card, { ...params, keys: { keys }, rotations: [st, ...(params.rotations ?? [])].slice(0, 5) });
    writeFileSync(file, JSON.stringify(await signCard(updated, next), null, 2) + "\n");
    console.log(`Rotated ${file}: ${st.prev} → ${await thumbprint(next.publicJwk)}, card re-signed with the new key. Publish the card, then sign new entries with the new key.`);
    return;
  }
  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}

main().catch((e) => {
  console.error(`rssa: ${e.message}`);
  process.exitCode = 2;
});

/** stdio transport: one JSON-RPC message per line on stdin, responses on stdout. */
async function serveMcpStdio(o: McpOptions = {}) {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      continue;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    const out = (await Promise.all(msgs.map((m) => handleMcpMessage(m as JsonRpc, o)))).filter((r) => r !== undefined);
    if (out.length) process.stdout.write(JSON.stringify(Array.isArray(msg) ? out : out[0]) + "\n");
  }
}
