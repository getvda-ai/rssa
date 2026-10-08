#!/usr/bin/env node
// rssa — validate agents, feeds and groups; generate keys; sign cards and policies.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { withRssa } from "./card.ts";
import { generateKey, keyFromJwk } from "./keys.ts";
import { parsePolicy, rosterOpml, signPolicy } from "./policy.ts";
import { formatReport, signCard, validate } from "./validate.ts";

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
  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}

main().catch((e) => {
  console.error(`rssa: ${e.message}`);
  process.exitCode = 2;
});
