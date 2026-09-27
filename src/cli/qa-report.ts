import { readFileSync } from "node:fs";
import { Report } from "../report/report.js";
import { renderMarkdown } from "../report/markdown.js";

/**
 * Re-render the markdown of a saved report, e.g. to post it on a PR:
 *   npm run qa:report -- .autotester/runs/check-…/report.json > comment.md
 *   gh pr comment <n> --body-file comment.md
 */
const file = process.argv[2];
if (!file) {
  console.error("usage: npm run qa:report -- <report.json>");
  process.exit(2);
}
process.stdout.write(renderMarkdown(Report.parse(JSON.parse(readFileSync(file, "utf8")))));
