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
