import { SEVERITY_LABELS, type FlowReport, type Report } from "./report.js";

/**
 * Advisory PR comment (M5, PER-56). Written for two readers:
 *   - a person skimming a pull request: verdict first, findings next, the rest folded
 *   - an LLM or tool: one self-contained sentence per flow, plus the summary as JSON in
 *     an HTML comment at the end
 * Deterministic: the same report always renders the same text.
 */

const VERDICT_LINE: Record<Report["verdict"], string> = {
  "likely-regression": "Likely regression",
  "possible-issue": "Possible issue, not confirmed",
  "no-regression-found": "No regression found in the tested flows",
  "nothing-tested": "Nothing could be tested",
};

// a PR comment stays readable; the full list is always in report.json
const MAX_NOT_TESTED = 25;

const code = (s: string) => "`" + s.replace(/`/g, "'") + "`";
const flowName = (f: FlowReport) => `${code(f.path ?? f.route ?? f.flow)}${f.label && f.label !== f.route ? ` (${f.label})` : ""}`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** One self-contained sentence about a flow: what happened, how sure, why it was looked at. */
export function flowSentence(f: FlowReport): string {
  const cause = f.likelyCause.length ? ` Linked to ${f.likelyCause.map(code).join(", ")}.` : "";
  if (f.outcome === "not-tested") return `Flow ${flowName(f)} was not tested: ${f.notTestedReason}.`;
  const checks = f.checks ? `${plural(f.checks.run, "expectation")} checked over ${plural(f.checks.attempts, "visit")}` : "";
  if (f.outcome === "passed") {
    return `Flow ${flowName(f)} PASSED with ${f.confidence} confidence (${f.confidenceWhy}).${cause}`;
  }
  const worst = [...f.findings].sort((a, b) => b.severity - a.severity)[0];
  const head = f.outcome === "failed" ? "FAILED" : "MAY HAVE AN ISSUE";
  const sev = worst ? ` Worst: severity ${worst.severity}/5 (${worst.severityLabel}), ${worst.reproduced === "stable" ? "reproduced on every visit" : "not reproduced"}.` : "";
  return `Flow ${flowName(f)} ${head} (${checks}).${sev}${cause}`;
}

export function renderMarkdown(r: Report): string {
  const tested = r.flows.filter((f) => f.outcome !== "not-tested");
  const bad = tested.filter((f) => f.outcome === "failed" || f.outcome === "maybe");
  const lines: string[] = [];

  lines.push("## Auto-tester report (advisory)");
  lines.push("");
  const worst = Math.max(-1, ...bad.flatMap((f) => f.findings.map((x) => x.severity)));
  const verdict = VERDICT_LINE[r.verdict] + (worst >= 0 && r.verdict !== "no-regression-found" ? `: worst severity ${worst}/5 (${SEVERITY_LABELS[worst]})` : "");
  lines.push(`**${verdict}.** ${plural(r.summary.failed, "flow")} failed, ${r.summary.maybe} uncertain, ${r.summary.passed} passed.`);
  lines.push("");
  lines.push(
    `Change ${code(r.target)}, ${plural(r.changedFiles.length, "file")} changed. ` +
      `${plural(r.summary.candidates, "candidate flow")} → ${r.summary.affected} judged affected by Jev` +
      `${r.summary.executionCheck ? " (execution check on)" : ""} → ${r.summary.tested} tested in the browser.`,
  );

  if (bad.length) {
    lines.push("", "### Findings", "");
    for (const f of bad) {
      lines.push(`- ${flowSentence(f)}`);
      for (const x of [...f.findings].sort((a, b) => b.severity - a.severity)) {
        lines.push(`  - **Severity ${x.severity}/5** (${x.severityLabel}, ${x.reproduced}). Expected: ${x.expected} Got: ${x.actual}`);
      }
      if (f.why.length) lines.push(`  - Why it was tested: ${f.why.slice(0, 2).join("; ")}`);
      if (f.screenshot) lines.push(`  - Evidence: ${code(f.screenshot)}`);
    }
  }

  const passed = tested.filter((f) => f.outcome === "passed");
  if (passed.length) {
    lines.push("", "### Passed", "");
    lines.push("| Flow | Confidence | Why it was tested |", "|---|---|---|");
    for (const f of passed) lines.push(`| ${flowName(f)} | ${f.confidence} (${f.confidenceWhy}) | ${(f.why[0] ?? "").replace(/\|/g, "\\|")} |`);
  }

  const notTested = r.flows.filter((f) => f.outcome === "not-tested");
  if (notTested.length) {
    const buckets = Object.entries(r.summary.notTestedBy)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    lines.push("", `<details><summary>Not tested: ${plural(notTested.length, "flow")} (${buckets})</summary>`, "");
    for (const f of notTested.slice(0, MAX_NOT_TESTED)) lines.push(`- ${flowSentence(f)}`);
    if (notTested.length > MAX_NOT_TESTED) lines.push(`- …and ${notTested.length - MAX_NOT_TESTED} more, listed in report.json`);
    lines.push("", "</details>");
  }

  lines.push(
    "",
    "---",
    `_Advisory only: this never blocks a merge. Jev: ${plural(r.jev.requests, "request")}, ${r.jev.tokens.toLocaleString("en-US")} tokens. ` +
      `Evidence (screenshots, observations): ${code(r.evidenceDir)}._`,
  );
  // machine-readable summary for tools and LLMs reading the comment
  lines.push(
    "",
    `<!-- auto-tester:summary ${JSON.stringify({ verdict: r.verdict, ...r.summary, failedFlows: bad.map((f) => f.path ?? f.route ?? f.flow) })} -->`,
  );
  return lines.join("\n") + "\n";
}
