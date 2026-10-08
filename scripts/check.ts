// npm run check — the end-to-end gate. Offline and deterministic.
//  1. The validator passes every demo card (deep: card → feed → keys → signatures → groups) and the policy.
//  2. The validator FAILS every file in demo/broken/ with the expected code (a check that cannot fail is decoration).
//  3. The Python SDK verifies every signed entry in the demo feeds (cross-language).
//  4. Test vectors are up to date (regenerating them changes nothing).

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validate, formatReport } from "../packages/sdk-js/src/index.ts";
import { demoFetch, DEMO_BASE } from "./demo-fetch.ts";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fetcher = demoFetch();
let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✔" : "✖"} ${msg}`);
  if (!cond) failures++;
};

// 1. Demo must be green.
for (const target of [
  `${DEMO_BASE}/brewer/.well-known/agent-card.json`,
  `${DEMO_BASE}/supplier/.well-known/agent-card.json`,
  `${DEMO_BASE}/logistics/.well-known/agent-card.json`,
  `${DEMO_BASE}/groups/supply-ops/policy.json`,
]) {
  const r = await validate(target, { fetcher });
  const warns = r.findings.filter((f) => f.level === "warn");
  ok(r.ok && warns.length === 0, `demo ${r.kind} validates clean: ${target.replace(DEMO_BASE, "")}`);
  if (!r.ok || warns.length) console.log(formatReport(r));
}

// 2. Broken inputs must be red, for the right reason.
const expected = JSON.parse(readFileSync(join(root, "demo", "broken", "EXPECTED.json"), "utf8")) as Record<string, { as: string; code: string }>;
const files = readdirSync(join(root, "demo", "broken")).filter((f) => f !== "EXPECTED.json");
ok(files.length === Object.keys(expected).length, `every broken file has an expectation (${files.length})`);
for (const [file, exp] of Object.entries(expected)) {
  const text = readFileSync(join(root, "demo", "broken", file), "utf8");
  const r = await validate(exp.as, { fetcher, text });
  const codes = r.findings.filter((f) => f.level === "fail").map((f) => f.code);
  ok(!r.ok && codes.includes(exp.code), `broken/${file} fails with ${exp.code}${codes.includes(exp.code) ? "" : ` (got ${codes.join(", ") || "PASS"})`}`);
}

// 2b. Core-only examples are valid (no signing, card not reachable is only a warning).
for (const [file, as] of [["minimal-card.json", "https://agent.example.com/.well-known/agent-card.json"], ["minimal-feed.atom", "https://agent.example.com/rssa/feed.atom"]]) {
  const r = await validate(as, { fetcher, text: readFileSync(join(root, "examples", file), "utf8"), deep: false });
  ok(r.ok, `examples/${file} is valid core RSSA`);
  if (!r.ok) console.log(formatReport(r));
}

// 2c. JSON Schemas accept the demo and reject the broken policy.
{
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const { default: addFormats } = await import("ajv-formats");
  const ajv = new (Ajv as any)({ allErrors: true, strict: false });
  (addFormats as any)(ajv);
  const schema = (n: string) => ajv.compile(JSON.parse(readFileSync(join(root, "schemas", n), "utf8")));
  const card = schema("card-extension.schema.json"), pol = schema("policy.schema.json"), pay = schema("entry-payload.schema.json");
  const site = (p: string) => readFileSync(join(root, "demo", "site", p), "utf8");
  for (const a of ["brewer", "supplier", "logistics"]) {
    const c = JSON.parse(site(`${a}/.well-known/agent-card.json`));
    ok(card(c.capabilities.extensions[0]), `schema: ${a} card extension`);
  }
  ok(card(JSON.parse(readFileSync(join(root, "examples", "minimal-card.json"), "utf8")).capabilities.extensions[0]), "schema: minimal card extension");
  ok(pol(JSON.parse(site("groups/supply-ops/policy.json"))), "schema: demo policy");
  ok(!pol(JSON.parse(readFileSync(join(root, "demo", "broken", "policy-float.json"), "utf8"))), "schema: rejects a float in policy");
  for (const v of JSON.parse(readFileSync(join(root, "test-vectors", "entries.json"), "utf8")).vectors) ok(pay(JSON.parse(v.payloadCanonical)), `schema: payload ${v.entry.id}`);
}

// 3. Cross-language: Python verifies what JS signed.
try {
  const out = execFileSync("python", [join(root, "scripts", "check_py.py")], { encoding: "utf8" });
  process.stdout.write(out);
  ok(/ALL VERIFIED/.test(out), "Python SDK verifies every demo entry");
} catch (e: any) {
  process.stdout.write(e.stdout ?? "");
  ok(false, `Python cross-check failed: ${e.message}`);
}

// 4. Vectors are reproducible.
const before = readdirSync(join(root, "test-vectors")).map((f) => readFileSync(join(root, "test-vectors", f), "utf8")).join("");
execFileSync(process.execPath, [join(root, "scripts", "make-vectors.ts")], { stdio: "ignore" });
const after = readdirSync(join(root, "test-vectors")).map((f) => readFileSync(join(root, "test-vectors", f), "utf8")).join("");
ok(before === after, "test vectors are reproducible (regeneration is a no-op)");

console.log(failures ? `\nFAIL: ${failures} check(s) failed` : "\nPASS: all checks green");
process.exitCode = failures ? 1 : 0;
