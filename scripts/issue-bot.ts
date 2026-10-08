// Validator bot for this repo's issues (.github/workflows/validate-issue.yml).
// Opt-in: runs when an issue contains a line `validate: https://…` (or has the `validate` label, in
// which case the first https URL in the body is used). Deterministic: it runs the same validator as
// `rssa validate` and posts its report. Nothing from the issue is executed; the URL is the only input.
//
// Entry point: scripts/issue-validate.ts. This file holds the logic (tested in hub/test/issue-bot.test.ts).

import { formatReport, validate } from "../packages/sdk-js/src/index.ts";

export function targetFrom(body: string, labels: string[] = []): string | undefined {
  const explicit = /^\s*validate:\s*(https:\/\/[^\s<>"'`)]+)/im.exec(body)?.[1];
  if (explicit) return explicit;
  if (labels.includes("validate")) return /(https:\/\/[^\s<>"'`)]+)/.exec(body)?.[1];
  return undefined;
}

export async function comment(url: string, fetcher?: (u: string, i?: RequestInit) => Promise<Response>): Promise<string> {
  const r = await validate(url, { fetcher });
  const fails = r.findings.filter((f) => f.level === "fail").length;
  const warns = r.findings.filter((f) => f.level === "warn").length;
  const head = r.ok
    ? `✅ **PASS**: \`${url}\` is RSS-A compliant (${r.findings.filter((f) => f.level === "pass").length} checks passed${warns ? `, ${warns} warning(s)` : ""}).`
    : `❌ **FAIL**: \`${url}\` has ${fails} failing check(s). Each one is explained below, with what to change.`;
  const report = formatReport(r, true).replace(/```/g, "ʼʼʼ").slice(0, 60_000);
  return `${head}\n\n<details open><summary>Validator report (${r.kind})</summary>\n\n\`\`\`\n${report}\n\`\`\`\n</details>\n\n` +
    `<sub>Automated: the same check as \`npx @rss-a/sdk validate ${url}\`. Edit the issue to re-run. A maintainer will follow up if the report doesn't answer your question.</sub>\n`;
}
