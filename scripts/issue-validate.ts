// Entry point for .github/workflows/validate-issue.yml (logic in issue-bot.ts).
//   ISSUE_BODY=… [ISSUE_LABELS=a,b] node scripts/issue-validate.ts > comment.md   (exit 0: comment written, 3: nothing to do)
import { comment, targetFrom } from "./issue-bot.ts";

const url = targetFrom(process.env.ISSUE_BODY ?? "", (process.env.ISSUE_LABELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
if (!url) process.exit(3);
process.stdout.write(await comment(url));
