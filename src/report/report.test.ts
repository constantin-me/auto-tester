import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, type BuildInput, type JudgedCandidate } from "./build.js";
import { flowSentence, renderMarkdown } from "./markdown.js";
import type { FlowNode } from "../mindmap/schema.js";
import type { Triage } from "../jev/judgments.js";

const node = (id: string, route: string, label = route): FlowNode => ({
  id,
  label,
  route,
  view: undefined,
  views: [],
  kind: "page",
  requiresAuth: true,
  guards: [],
  assertions: [],
  provenance: { sourceFiles: [], origin: "static-crawl", confidence: 0.6 },
});
const triage = (affected: boolean, pRuns = 0.9): Triage => ({
  affected,
  pRuns,
  pAlters: 0.8,
  pPreserving: 0.03,
  impact: 2,
  impactConfidence: 0.8,
  criticality: 2,
  value: 0.7,
  escalate: false,
});
const judged = (n: FlowNode, over: Partial<JudgedCandidate> = {}): JudgedCandidate => ({
  node: n,
  reasons: ["app.ts: inline middleware changed"],
  files: ["app.ts"],
  triage: triage(true),
  affected: true,
  ...over,
});

function input(over: Partial<BuildInput> = {}): BuildInput {
  const search = node("node:search", "/search", "Search");
  const home = node("node:root", "/", "Home");
  const add = node("node:add-music", "/add-music", "Add music");
  const books = node("node:add-books", "/add-books", "Add books");
  return {
    repo: "x/y",
    target: "--working-tree",
    generatedAt: "2026-09-27T00:00:00.000Z",
    changedFiles: ["app.ts"],
    judged: [
      judged(search),
      judged(home, { reasons: ["renders views/index.ejs (changed)"], files: ["views/index.ejs"] }),
      judged(add, { triage: triage(true), pDiffers: 0.12, affected: false }),
      judged(books),
    ],
    results: [
      {
        flow: "node:search",
        path: "/search",
        status: "failed",
        attempts: 3,
        checksRun: 30,
        settled: true,
        findings: [{ kind: "status", expectation: "/search loads (baseline HTTP 200)", actual: "HTTP 500", severity: 5, severityConfidence: 0.9, confidence: "stable" }],
        screenshot: "/runs/r1/node_search.png",
      },
      { flow: "node:root", path: "/", status: "passed", attempts: 1, checksRun: 32, settled: true, findings: [] },
      { flow: "node:add-books", path: "/add-books", status: "unreachable-here", reason: "404 at baseline too (module disabled here)" },
    ],
    untriaged: [],
    budget: { cap: 200_000, spent: 1010, reserveForChecks: 0.3 },
    executionCheck: true,
    dropBelow: 0.45,
    usage: [{ purpose: "triage", model: "jev-1.13.0", inputTokens: 1000, outputTokens: 10 }],
    evidenceDir: "/runs/r1",
    ...over,
  };
}

test("report: verdict, summary buckets, ordering, relative evidence", () => {
  const r = buildReport(input());
  assert.equal(r.verdict, "likely-regression");
  assert.deepEqual(
    { candidates: r.summary.candidates, affected: r.summary.affected, tested: r.summary.tested, failed: r.summary.failed, passed: r.summary.passed, notTested: r.summary.notTested },
    { candidates: 4, affected: 3, tested: 2, failed: 1, passed: 1, notTested: 2 },
  );
  assert.deepEqual(r.summary.notTestedBy, { "execution check: change does not reach it": 1, "unreachable on this instance": 1 });
  assert.deepEqual(r.flows.map((f) => f.outcome), ["failed", "passed", "not-tested", "not-tested"]);
  assert.equal(r.flows[0]!.screenshot, "node_search.png");
  assert.equal(r.flows[0]!.findings[0]!.severityLabel, "release blocker");
  assert.equal(r.advisory, true);
});

test("an unreproduced deviation is never a likely regression", () => {
  const i = input();
  i.results = [
    { flow: "node:search", path: "/search", status: "maybe", attempts: 3, checksRun: 30, settled: true, findings: [{ kind: "assertion", expectation: "e", actual: "a", severity: 4, confidence: "maybe" }] },
  ];
  const r = buildReport(i);
  assert.equal(r.verdict, "possible-issue");
  assert.equal(r.flows[0]!.confidence, "low");
});

test("markdown: verdict first, one sentence per flow, folded not-tested list, machine summary", () => {
  const md = renderMarkdown(buildReport(input()));
  const lines = md.split("\n");
  assert.equal(lines[0], "## Auto-tester report (advisory)");
  assert.match(lines[2]!, /^\*\*Likely regression: worst severity 5\/5 \(release blocker\)\.\*\*/);
  assert.match(md, /Flow `\/search` \(Search\) FAILED \(30 expectations checked over 3 visits\)\. Worst: severity 5\/5 \(release blocker\), reproduced on every visit\. Linked to `app\.ts`\./);
  assert.match(md, /Expected: \/search loads \(baseline HTTP 200\) Got: HTTP 500/);
  assert.match(md, /<details><summary>Not tested: 2 flows/);
  assert.match(md, /execution check: P\(the change gives this flow a different result\) = 0\.12, below 0\.45/);
  const summary = JSON.parse(md.match(/<!-- auto-tester:summary (.*) -->/)![1]!);
  assert.deepEqual(summary.failedFlows, ["/search"]);
  assert.match(md, /Advisory only: this never blocks a merge/);
});

test("flowSentence for a passed flow states its confidence and reason", () => {
  const r = buildReport(input());
  const home = r.flows.find((f) => f.flow === "node:root")!;
  assert.equal(flowSentence(home), "Flow `/` (Home) PASSED with high confidence (all 32 expectations held on a settled page). Linked to `views/index.ejs`.");
});

test("renders the same text for the same report", () => {
  const r = buildReport(input());
  assert.equal(renderMarkdown(r), renderMarkdown(r));
});

test("the not-tested list is capped in markdown, never in the JSON", () => {
  const i = input();
  const extra = Array.from({ length: 40 }, (_, k) => node(`node:x${k}`, `/x${k}`));
  i.judged = [...i.judged, ...extra.map((n) => judged(n, { triage: triage(false, 0.2), affected: false }))];
  const r = buildReport(i);
  const md = renderMarkdown(r);
  assert.equal(r.flows.filter((f) => f.outcome === "not-tested").length, 42);
  assert.equal((md.match(/was not tested:/g) ?? []).length, 25);
  assert.match(md, /…and 17 more, listed in report\.json/);
});

test("report: budget cap leaves candidates and visits as skipped-budget, run is partial", () => {
  const extra = node("node:extra", "/extra", "Extra");
  const late = node("node:late", "/late", "Late");
  const r = buildReport(
    input({
      judged: [judged(node("node:search", "/search", "Search")), judged(late)],
      untriaged: [{ node: extra, reasons: ["views/x.ejs: indirect"], files: ["views/x.ejs"] }],
      results: [{ flow: "node:late", path: "/late", status: "skipped-budget", reason: "budget: token cap reached before it was visited" }],
      budget: { cap: 1000, spent: 1180, reserveForChecks: 0.3 },
    }),
  );
  assert.deepEqual(r.budget, { cap: 1000, spent: 1180, reserveForChecks: 0.3, partial: true, notTriaged: 1, notVisited: 1 });
  assert.equal(r.summary.candidates, 3);
  const skipped = r.flows.filter((f) => f.notTestedStatus === "skipped-budget").map((f) => f.flow).sort();
  assert.deepEqual(skipped, ["node:extra", "node:late"]);
  assert.equal(r.summary.notTestedBy["budget: token cap reached"], 2);
  const md = renderMarkdown(r);
  assert.match(md, /Partial run: the 1,000-token budget ran out/);
  assert.match(md, /1 candidate flow not judged and 1 affected flow not visited/);
  assert.match(md, /token cap reached before it was visited/);
});

test("report: a run within budget is not partial", () => {
  const r = buildReport(input());
  assert.equal(r.budget?.partial, false);
  assert.match(renderMarkdown(r), /Budget: 1,010 of 200,000 tokens spent/);
});

test("report: an expectation finding carries its assertion, pinned flag and held-at-baseline; the summary counts comparisons", () => {
  const i = input();
  i.results = [
    {
      flow: "node:search",
      path: "/search",
      status: "failed",
      attempts: 3,
      checksRun: 7,
      settled: true,
      comparison: { compared: 3, skippedNoBaseline: 2 },
      findings: [{ kind: "expectation", expectation: "Search shows a results table", actual: "selector #results is not visible", assertionId: "a1", pinned: true, decidedBy: "check", severity: 4, confidence: "stable" }],
    },
    { flow: "node:root", path: "/", status: "passed", attempts: 1, checksRun: 6, settled: true, comparison: { compared: 4, skippedNoBaseline: 0 }, findings: [] },
  ];
  const r = buildReport(i);
  const f = r.flows.find((x) => x.flow === "node:search")!.findings[0]!;
  assert.deepEqual([f.kind, f.assertionId, f.pinned, f.heldAtBaseline], ["expectation", "a1", true, true]);
  assert.deepEqual(r.summary.comparison, { compared: 7, skippedNoBaseline: 2 });
  assert.equal(r.verdict, "likely-regression");
  const md = renderMarkdown(r);
  assert.match(md, /Expected: Search shows a results table Got: selector #results is not visible\. Held at baseline \(pinned by a human\)\./);
  assert.match(md, /Map expectations: 7 assertions held at baseline and were re-checked; 2 skipped with no baseline state/);
});

test("report: an unpinned expectation finding says so, and non-expectation findings carry no baseline claim", () => {
  const i = input();
  i.results = [
    { flow: "node:search", path: "/search", status: "maybe", attempts: 3, checksRun: 5, settled: true, findings: [
      { kind: "expectation", expectation: "e", actual: "a", assertionId: "a2", pinned: false, decidedBy: "jev", severity: 3, confidence: "maybe" },
      { kind: "status", expectation: "s", actual: "HTTP 500", severity: 5, confidence: "maybe" },
    ] },
  ];
  const r = buildReport(i);
  const [exp, status] = [r.flows[0]!.findings.find((x) => x.kind === "expectation")!, r.flows[0]!.findings.find((x) => x.kind === "status")!];
  assert.equal(exp.pinned, false);
  assert.equal(status.heldAtBaseline, undefined);
  const md = renderMarkdown(r);
  assert.match(md, /Held at baseline \(not pinned\)\./);
  assert.equal((md.match(/Held at baseline/g) ?? []).length, 1);
});

test("markdown: nothing tested reads as clean when the change reaches no flow or none is affected", () => {
  const none = buildReport(input({ judged: [], results: [] }));
  assert.equal(none.verdict, "nothing-tested");
  assert.match(renderMarkdown(none), /\*\*No UI flow is reached by this change\.\*\*/);

  const i = input({ results: [] });
  i.judged = i.judged.map((j) => ({ ...j, triage: triage(false, 0.2), affected: false }));
  assert.match(renderMarkdown(buildReport(i)), /\*\*No flow is judged affected by this change\.\*\*/);

  const flows = ["search", "root", "add-music", "add-books"];
  const blocked = buildReport(input({ results: flows.map((f) => ({ flow: `node:${f}`, status: "unreachable-here", reason: "404" }) as never) }));
  assert.equal(blocked.verdict, "nothing-tested");
  assert.match(renderMarkdown(blocked), /\*\*Nothing could be tested\.\*\*/);
});
