#!/usr/bin/env node
// npx @rss-a/validate <url | file> — a thin alias for `rssa validate` from @rss-a/sdk.
import { readFileSync } from "node:fs";
import { validate, formatReport } from "@rss-a/sdk";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.log("usage: rssa-validate <agent origin | card URL | feed URL | policy URL | file> [--json] [--verbose] [--shallow]");
  process.exit(2);
}
const isUrl = /^https?:\/\//.test(target);
const report = await validate(target, { deep: !args.includes("--shallow"), ...(isUrl ? {} : { text: readFileSync(target, "utf8") }) });
console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report, args.includes("--verbose")));
process.exitCode = report.ok ? 0 : 1;
