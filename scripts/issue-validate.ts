// Entry point for .github/workflows/validate-issue.yml (logic in issue-bot.ts).
//   ISSUE_TITLE=… ISSUE_BODY=… [ISSUE_LABELS=a,b] node scripts/issue-validate.ts > comment.md
//   exit 0: comment written; exit 3: the issue isn't for the bot.
import { respond } from "./issue-bot.ts";

const md = await respond({
  title: process.env.ISSUE_TITLE ?? "",
  body: process.env.ISSUE_BODY ?? "",
  labels: (process.env.ISSUE_LABELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});
if (!md) process.exit(3);
process.stdout.write(md);
